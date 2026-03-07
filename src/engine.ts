/**
 * ATR Engine - Evaluates agent events against ATR rules
 *
 * Core detection engine that:
 * 1. Loads ATR YAML rules from disk
 * 2. Evaluates agent events (LLM I/O, tool calls, behaviors) against rules
 * 3. Returns matched rules with confidence scores
 * 4. Supports pattern matching, behavioral thresholds, and sequence detection
 *
 * @module @panguard-ai/atr/engine
 */

import type {
  ATRRule,
  ATRMatch,
  AgentEvent,
  ATRPatternCondition,
  ATRBehavioralCondition,
  ATRDetection,
} from './types.js';
import { loadRulesFromDirectory, loadRuleFile } from './loader.js';

/** Map agent event types to ATR source types */
const EVENT_TYPE_TO_SOURCE: Record<string, string> = {
  llm_input: 'llm_io',
  llm_output: 'llm_io',
  tool_call: 'tool_call',
  tool_response: 'mcp_exchange',
  agent_behavior: 'agent_behavior',
  multi_agent_message: 'multi_agent_comm',
};

/** Map agent event types to default field names */
const EVENT_TYPE_TO_FIELD: Record<string, string> = {
  llm_input: 'user_input',
  llm_output: 'agent_output',
  tool_call: 'tool_name',
  tool_response: 'tool_response',
  agent_behavior: 'metric',
  multi_agent_message: 'agent_message',
};

export interface ATREngineConfig {
  /** Directory containing ATR rule YAML files */
  rulesDir?: string;
  /** Pre-loaded rules (for testing or embedding) */
  rules?: ATRRule[];
  /** Enable hot-reload of rule files */
  hotReload?: boolean;
}

export class ATREngine {
  private rules: ATRRule[] = [];
  private readonly compiledPatterns = new Map<string, Map<string, RegExp[]>>();

  constructor(private readonly config: ATREngineConfig = {}) {}

  /**
   * Load rules from configured directory and/or pre-loaded rules.
   */
  async loadRules(): Promise<number> {
    this.rules = [];
    this.compiledPatterns.clear();

    if (this.config.rules) {
      this.rules.push(...this.config.rules);
    }

    if (this.config.rulesDir) {
      try {
        const fileRules = loadRulesFromDirectory(this.config.rulesDir);
        this.rules.push(...fileRules);
      } catch {
        // Directory may not exist yet
      }
    }

    // Pre-compile regex patterns for performance
    for (const rule of this.rules) {
      this.compilePatterns(rule);
    }

    return this.rules.length;
  }

  /**
   * Load a single rule file and add it to the engine.
   */
  addRuleFile(filePath: string): void {
    const rule = loadRuleFile(filePath);
    this.rules.push(rule);
    this.compilePatterns(rule);
  }

  /**
   * Add a pre-parsed rule to the engine.
   */
  addRule(rule: ATRRule): void {
    this.rules.push(rule);
    this.compilePatterns(rule);
  }

  /**
   * Evaluate an agent event against all loaded ATR rules.
   * Returns all matching rules with details.
   */
  evaluate(event: AgentEvent): ATRMatch[] {
    const matches: ATRMatch[] = [];
    const eventSourceType = EVENT_TYPE_TO_SOURCE[event.type];

    for (const rule of this.rules) {
      // Skip deprecated rules
      if (rule.status === 'deprecated') continue;

      // Source type filtering: skip rules that don't apply to this event type
      if (eventSourceType && rule.agent_source.type !== eventSourceType) {
        // Allow mcp_exchange rules to also match tool_call events
        if (!(rule.agent_source.type === 'mcp_exchange' && eventSourceType === 'tool_call')) {
          continue;
        }
      }

      const matchResult = this.evaluateRule(rule, event);
      if (matchResult) {
        matches.push(matchResult);
      }
    }

    // Sort by severity (critical first) then confidence
    return matches.sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 };
      const aSev = severityOrder[a.rule.severity] ?? 4;
      const bSev = severityOrder[b.rule.severity] ?? 4;
      if (aSev !== bSev) return aSev - bSev;
      return b.confidence - a.confidence;
    });
  }

  /**
   * Evaluate a single rule against an event.
   */
  private evaluateRule(rule: ATRRule, event: AgentEvent): ATRMatch | null {
    const { detection } = rule;
    const conditionResults = new Map<string, boolean>();
    const allMatchedPatterns: string[] = [];
    const matchedConditionNames: string[] = [];

    // Evaluate each named condition block
    for (const [condName, condDef] of Object.entries(detection.conditions)) {
      const result = this.evaluateCondition(condName, condDef, event, rule, allMatchedPatterns);
      conditionResults.set(condName, result);
      if (result) {
        matchedConditionNames.push(condName);
      }
    }

    // Evaluate the boolean expression
    const finalResult = this.evaluateExpression(detection.condition, conditionResults);

    if (!finalResult) return null;

    // Calculate confidence based on rule confidence tag and match quality
    const baseConfidence = rule.tags.confidence === 'high' ? 0.9 : rule.tags.confidence === 'medium' ? 0.7 : 0.5;
    const matchRatio = matchedConditionNames.length / Math.max(Object.keys(detection.conditions).length, 1);
    const confidence = Math.min(baseConfidence + matchRatio * 0.1, 1.0);

    return {
      rule,
      matchedConditions: matchedConditionNames,
      matchedPatterns: allMatchedPatterns,
      confidence,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Evaluate a single named condition against an event.
   */
  private evaluateCondition(
    condName: string,
    condDef: unknown,
    event: AgentEvent,
    rule: ATRRule,
    matchedPatterns: string[]
  ): boolean {
    const cond = condDef as Record<string, unknown>;

    // Pattern matching condition
    if (cond['patterns'] && cond['field']) {
      return this.evaluatePatternCondition(
        cond as unknown as ATRPatternCondition,
        event,
        rule.id,
        condName,
        matchedPatterns
      );
    }

    // Behavioral condition
    if (cond['metric'] && cond['operator'] && cond['threshold'] !== undefined) {
      return this.evaluateBehavioralCondition(cond as unknown as ATRBehavioralCondition, event);
    }

    // Sequence condition
    if (cond['steps'] && Array.isArray(cond['steps'])) {
      // Sequence detection requires stateful tracking (simplified: check if content matches all steps)
      return this.evaluateSequenceCondition(cond, event);
    }

    return false;
  }

  /**
   * Evaluate a pattern matching condition.
   */
  private evaluatePatternCondition(
    cond: ATRPatternCondition,
    event: AgentEvent,
    ruleId: string,
    condName: string,
    matchedPatterns: string[]
  ): boolean {
    // Resolve the field value from the event
    const fieldValue = this.resolveField(cond.field, event);
    if (!fieldValue) return false;

    // Get pre-compiled patterns
    const cacheKey = `${ruleId}:${condName}`;
    const compiled = this.compiledPatterns.get(ruleId)?.get(condName);

    if (compiled) {
      for (let i = 0; i < compiled.length; i++) {
        if (compiled[i]!.test(fieldValue)) {
          matchedPatterns.push(cond.patterns[i] ?? 'unknown');
          return true;
        }
      }
      return false;
    }

    // Fallback: direct string matching
    const checkValue = cond.case_sensitive ? fieldValue : fieldValue.toLowerCase();

    for (const pattern of cond.patterns) {
      const checkPattern = cond.case_sensitive ? pattern : pattern.toLowerCase();

      switch (cond.match_type) {
        case 'contains':
          if (checkValue.includes(checkPattern)) {
            matchedPatterns.push(pattern);
            return true;
          }
          break;
        case 'exact':
          if (checkValue === checkPattern) {
            matchedPatterns.push(pattern);
            return true;
          }
          break;
        case 'starts_with':
          if (checkValue.startsWith(checkPattern)) {
            matchedPatterns.push(pattern);
            return true;
          }
          break;
        case 'regex':
        default: {
          try {
            const flags = cond.case_sensitive ? '' : 'i';
            const regex = new RegExp(pattern, flags);
            if (regex.test(fieldValue)) {
              matchedPatterns.push(pattern);
              return true;
            }
          } catch {
            // Invalid regex, skip
          }
          break;
        }
      }
    }

    return false;
  }

  /**
   * Evaluate a behavioral threshold condition.
   */
  private evaluateBehavioralCondition(
    cond: ATRBehavioralCondition,
    event: AgentEvent
  ): boolean {
    const metricValue = event.metrics?.[cond.metric];
    if (metricValue === undefined) return false;

    switch (cond.operator) {
      case 'gt': return metricValue > cond.threshold;
      case 'lt': return metricValue < cond.threshold;
      case 'eq': return metricValue === cond.threshold;
      case 'gte': return metricValue >= cond.threshold;
      case 'lte': return metricValue <= cond.threshold;
      case 'deviation_from_baseline':
        // For deviation, threshold represents standard deviations
        // The metric value should already be normalized to deviation units
        return Math.abs(metricValue) > cond.threshold;
      default:
        return false;
    }
  }

  /**
   * Evaluate a sequence condition (simplified: checks content against all step patterns).
   */
  private evaluateSequenceCondition(
    cond: Record<string, unknown>,
    event: AgentEvent
  ): boolean {
    const steps = cond['steps'] as Array<Record<string, unknown>>;
    if (!steps || steps.length === 0) return false;

    // Simplified: check if the event content matches patterns from any step
    // Full sequence tracking would require a stateful session buffer
    let matchCount = 0;
    for (const step of steps) {
      const patterns = step['patterns'] as string[] | undefined;
      if (patterns) {
        for (const pattern of patterns) {
          try {
            const regex = new RegExp(pattern, 'i');
            if (regex.test(event.content)) {
              matchCount++;
              break;
            }
          } catch {
            // Invalid regex
          }
        }
      }
    }

    // Require at least 2 step matches for sequence detection in single-event mode
    return matchCount >= 2;
  }

  /**
   * Resolve a field value from an agent event.
   */
  private resolveField(fieldName: string, event: AgentEvent): string | undefined {
    // Check explicit fields first
    if (event.fields?.[fieldName]) {
      return event.fields[fieldName];
    }

    // Map standard field names to event properties
    const defaultField = EVENT_TYPE_TO_FIELD[event.type];
    if (fieldName === defaultField || fieldName === 'content') {
      return event.content;
    }

    // Common field aliases
    switch (fieldName) {
      case 'user_input':
        return event.type === 'llm_input' ? event.content : event.fields?.['user_input'];
      case 'agent_output':
        return event.type === 'llm_output' ? event.content : event.fields?.['agent_output'];
      case 'tool_response':
        return event.type === 'tool_response' ? event.content : event.fields?.['tool_response'];
      case 'tool_name':
        return event.fields?.['tool_name'] ?? (event.type === 'tool_call' ? event.content : undefined);
      case 'tool_args':
        return event.fields?.['tool_args'];
      case 'agent_message':
        return event.type === 'multi_agent_message' ? event.content : event.fields?.['agent_message'];
      default:
        // Try metadata
        return event.metadata?.[fieldName] as string | undefined;
    }
  }

  /**
   * Evaluate a boolean expression string against condition results.
   * Supports AND, OR, NOT operators.
   */
  private evaluateExpression(
    expression: string,
    results: Map<string, boolean>
  ): boolean {
    const expr = expression.trim();

    // Simple single condition
    if (results.has(expr)) {
      return results.get(expr) ?? false;
    }

    // Handle NOT
    if (expr.startsWith('NOT ') || expr.startsWith('not ')) {
      const inner = expr.slice(4).trim();
      return !this.evaluateExpression(inner, results);
    }

    // Handle OR (lower precedence)
    const orParts = this.splitByOperator(expr, 'OR');
    if (orParts.length > 1) {
      return orParts.some((part) => this.evaluateExpression(part, results));
    }

    // Handle AND (higher precedence)
    const andParts = this.splitByOperator(expr, 'AND');
    if (andParts.length > 1) {
      return andParts.every((part) => this.evaluateExpression(part, results));
    }

    // Handle parentheses
    if (expr.startsWith('(') && expr.endsWith(')')) {
      return this.evaluateExpression(expr.slice(1, -1), results);
    }

    // Default: treat as condition name
    return results.get(expr) ?? false;
  }

  /**
   * Split expression by operator, respecting parentheses.
   */
  private splitByOperator(expr: string, operator: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    const op = ` ${operator} `;
    const opLower = ` ${operator.toLowerCase()} `;

    for (let i = 0; i < expr.length; i++) {
      const char = expr[i]!;
      if (char === '(') depth++;
      if (char === ')') depth--;

      if (depth === 0) {
        const remaining = expr.slice(i);
        if (remaining.startsWith(op) || remaining.startsWith(opLower)) {
          parts.push(current.trim());
          current = '';
          i += op.length - 1;
          continue;
        }
      }

      current += char;
    }

    if (current.trim()) {
      parts.push(current.trim());
    }

    return parts;
  }

  /**
   * Pre-compile regex patterns for a rule (performance optimization).
   */
  private compilePatterns(rule: ATRRule): void {
    const ruleMap = new Map<string, RegExp[]>();

    for (const [condName, condDef] of Object.entries(rule.detection.conditions)) {
      const cond = condDef as unknown as Record<string, unknown>;
      if (cond['patterns'] && Array.isArray(cond['patterns'])) {
        const matchType = (cond['match_type'] as string) ?? 'regex';
        const caseSensitive = (cond['case_sensitive'] as boolean) ?? false;
        const flags = caseSensitive ? '' : 'i';

        const compiled: RegExp[] = [];
        for (const pattern of cond['patterns'] as string[]) {
          try {
            if (matchType === 'regex') {
              compiled.push(new RegExp(pattern, flags));
            } else if (matchType === 'contains') {
              compiled.push(new RegExp(escapeRegex(pattern), flags));
            } else if (matchType === 'exact') {
              compiled.push(new RegExp(`^${escapeRegex(pattern)}$`, flags));
            } else if (matchType === 'starts_with') {
              compiled.push(new RegExp(`^${escapeRegex(pattern)}`, flags));
            }
          } catch {
            // Invalid regex pattern, skip compilation
          }
        }

        ruleMap.set(condName, compiled);
      }
    }

    this.compiledPatterns.set(rule.id, ruleMap);
  }

  /** Get loaded rule count */
  getRuleCount(): number {
    return this.rules.length;
  }

  /** Get all loaded rules */
  getRules(): readonly ATRRule[] {
    return this.rules;
  }

  /** Get a rule by ID */
  getRuleById(id: string): ATRRule | undefined {
    return this.rules.find((r) => r.id === id);
  }

  /** Get rules by category */
  getRulesByCategory(category: string): ATRRule[] {
    return this.rules.filter((r) => r.tags.category === category);
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
