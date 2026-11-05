/**
 * @file diagnose_workflow_failure tool definition.
 *
 * A composite tool that leverages the pi-coding-agent `ctx.executeTool()`
 * orchestration API to diagnose a GitHub Actions workflow run failure directly
 * from a workflow run URL:
 *
 *   parse URL (extract run ID & repo) → get_workflow_run_logs → summarize_text
 *
 * Acts similarly to diagnose_ci_failure, but targets a specific workflow run URL
 * rather than querying PR/commit CI status.
 */

import { Type, Static } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import {
  DIAGNOSE_WORKFLOW_FAILURE_PROMPT_SNIPPET,
  DIAGNOSE_WORKFLOW_FAILURE_PROMPT_GUIDELINES,
  DIAGNOSE_WORKFLOW_FAILURE_DESCRIPTION,
  DIAGNOSE_WORKFLOW_FAILURE_PARAM_RUN_URL_DESCRIPTION,
  DIAGNOSE_WORKFLOW_FAILURE_PARAM_OWNER_DESCRIPTION,
  DIAGNOSE_WORKFLOW_FAILURE_PARAM_REPO_DESCRIPTION,
  DIAGNOSE_WORKFLOW_FAILURE_PARAM_FOCUS_DESCRIPTION,
  DIAGNOSE_WORKFLOW_FAILURE_PARAM_MAX_WORDS_DESCRIPTION,
} from '../prompt';
import { CANCELLATION_MESSAGE_DIAGNOSE_WORKFLOW_FAILURE } from './constants';
import { nullable, PREFER_STRICT_JSON_SCHEMA } from './schema';
import { withCancellation, isPresent } from './tool-execution';
import {
  PI_ACTION_NAMESPACE,
  READ_ONLY_ANNOTATIONS,
  diagnoseWorkflowOutputSchema,
  toStructuredContent,
} from './metadata';
import { extractStructured, buildLogText } from './diagnose-ci-failure';
import type { AgentToolResult, ExtensionToolContext } from '@earendil-works/pi-coding-agent';

/** Details returned with each diagnose_workflow_failure tool result. */
export interface DiagnoseWorkflowFailureDetails {
  /** The workflow run URL passed to the tool. */
  run_url: string;
  /** Workflow run ID parsed from the URL. */
  run_id?: number;
  /** Repository owner (parsed from URL or params). */
  owner?: string;
  /** Repository name (parsed from URL or params). */
  repo?: string;
  /** Whether a summary was produced. */
  summarized: boolean;
  /** The root-cause summary (empty when not summarized). */
  summary: string;
  /** Error message when a step or nested call failed. */
  error?: string;
  /** Set when the tool was cancelled via the abort signal. */
  cancelled?: boolean;
}

/** Parsed workflow run URL components. */
export interface ParsedWorkflowRunUrl {
  owner?: string;
  repo?: string;
  runId: number;
}

/**
 * Regex to match GitHub Actions workflow run URLs.
 * Matches:
 *   https://github.com/{owner}/{repo}/actions/runs/{runId}(/job/{jobId}|/attempts/{attempt})?
 * Also handles URLs without scheme or with trailing paths/slashes.
 */
const WORKFLOW_RUN_URL_PATTERN =
  /(?:https?:\/\/[^/]+\/)?([^/\s]+)\/([^/\s]+)\/actions\/runs\/(\d+)(?:[/?#]|$)/i;

/** Fallback regex matching just /actions/runs/{runId} */
const RUN_ID_FALLBACK_PATTERN = /\/actions\/runs\/(\d+)(?:[/?#]|$)/i;

/**
 * Parse a GitHub Actions workflow run URL to extract run ID and optionally owner/repo.
 *
 * @param url - The workflow run URL.
 * @returns The parsed components, or undefined if no run ID could be found.
 */
export function parseWorkflowRunUrl(url: string): ParsedWorkflowRunUrl | undefined {
  const trimmed = url.trim();
  if (!trimmed) {
    return undefined;
  }

  const fullMatch = trimmed.match(WORKFLOW_RUN_URL_PATTERN);
  if (fullMatch?.[1] && fullMatch[2] && fullMatch[3]) {
    const runId = Number.parseInt(fullMatch[3], 10);
    if (!Number.isNaN(runId)) {
      return {
        owner: fullMatch[1],
        repo: fullMatch[2],
        runId,
      };
    }
  }

  const fallbackMatch = trimmed.match(RUN_ID_FALLBACK_PATTERN);
  if (fallbackMatch?.[1]) {
    const runId = Number.parseInt(fallbackMatch[1], 10);

    if (!Number.isNaN(runId)) {
      return { runId };
    }
  }

  return undefined;
}

/** Structured shape of the get_workflow_run_logs result we consume. */
interface WorkflowLogsStructured {
  run_id?: number;
  jobs?: { name?: string; log?: string }[];
  error?: string;
}

/** Structured shape of the summarize_text result we consume. */
interface SummarizeStructured {
  summary?: string;
  error?: string;
}

/**
 * Schema for the diagnose_workflow_failure tool.
 */
const diagnoseWorkflowFailureSchema = Type.Object(
  {
    run_url: Type.String({ description: DIAGNOSE_WORKFLOW_FAILURE_PARAM_RUN_URL_DESCRIPTION }),
    owner: nullable(
      Type.String({ description: DIAGNOSE_WORKFLOW_FAILURE_PARAM_OWNER_DESCRIPTION })
    ),
    repo: nullable(Type.String({ description: DIAGNOSE_WORKFLOW_FAILURE_PARAM_REPO_DESCRIPTION })),
    focus: nullable(
      Type.String({ description: DIAGNOSE_WORKFLOW_FAILURE_PARAM_FOCUS_DESCRIPTION })
    ),
    max_words: nullable(
      Type.Integer({ description: DIAGNOSE_WORKFLOW_FAILURE_PARAM_MAX_WORDS_DESCRIPTION })
    ),
  },
  { additionalProperties: false }
);

type DiagnoseWorkflowFailureToolParams = Static<typeof diagnoseWorkflowFailureSchema>;

/** Result returned by the diagnose handler. */
type DiagnoseWorkflowResult = AgentToolResult<DiagnoseWorkflowFailureDetails>;

/** Build a uniform result with matching structured content. */
function diagnoseWorkflowResult(
  content: string,
  details: DiagnoseWorkflowFailureDetails,
  isError = false
): DiagnoseWorkflowResult {
  return {
    content: [{ type: 'text', text: content }],
    details,
    structuredContent: toStructuredContent(details),
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Run the diagnose_workflow_failure flow: parse URL → get logs → summary.
 *
 * @param params - Resolved tool parameters.
 * @param ctx - Tool context providing `executeTool` and `tools`.
 */
export async function executeDiagnoseWorkflowFailure(
  params: DiagnoseWorkflowFailureToolParams,
  ctx: ExtensionToolContext
): Promise<DiagnoseWorkflowResult> {
  const baseDetails: DiagnoseWorkflowFailureDetails = {
    run_url: params.run_url,
    summarized: false,
    summary: '',
  };

  // 1. Parse run ID and optional owner/repo from URL
  const parsed = parseWorkflowRunUrl(params.run_url);
  if (!parsed) {
    const error = `Could not parse workflow run ID from URL: ${params.run_url}`;
    return diagnoseWorkflowResult(error, { ...baseDetails, error }, true);
  }

  const runId = parsed.runId;
  const owner = isPresent(params.owner) ? params.owner : parsed.owner;
  const repo = isPresent(params.repo) ? params.repo : parsed.repo;

  const details: DiagnoseWorkflowFailureDetails = {
    run_url: params.run_url,
    run_id: runId,
    ...(owner ? { owner } : {}),
    ...(repo ? { repo } : {}),
    summarized: false,
    summary: '',
  };

  // 2. Fetch logs for the workflow run ID
  const logsOutcome = await ctx.executeTool('get_workflow_run_logs', {
    ...(owner ? { owner } : {}),
    ...(repo ? { repo } : {}),
    run_id: runId,
  });
  const logs = extractStructured<WorkflowLogsStructured>(logsOutcome);
  if (logsOutcome.isError) {
    const error = logs?.error ?? 'unknown error';
    return diagnoseWorkflowResult(
      `Failed to retrieve logs for workflow run ${runId}: ${error}`,
      { ...details, error },
      true
    );
  }

  const logText = buildLogText(logs?.jobs);

  // 3. Summarize the logs (falls back to raw log tail when summarize_text is absent)
  const summaryFocus = isPresent(params.focus)
    ? params.focus
    : 'errors, root causes, and failed steps';
  const canSummarize = ctx.tools.some(tool => tool.name === 'summarize_text');

  if (logText && canSummarize) {
    const summaryOutcome = await ctx.executeTool('summarize_text', {
      text: logText,
      focus: summaryFocus,
      ...(isPresent(params.max_words) ? { max_words: params.max_words } : {}),
    });
    const summary = extractStructured<SummarizeStructured>(summaryOutcome);
    if (summaryOutcome.isError || !summary?.summary) {
      const error = summary?.error ?? 'summarization returned no content';
      const fallback = `\n\n(Summarization failed: ${error}. Raw log tail follows.)\n\n${logText.slice(-4000)}`;
      return diagnoseWorkflowResult(`Workflow run ${runId} failure diagnosis.${fallback}`, {
        ...details,
        error,
      });
    }
    details.summarized = true;
    details.summary = summary.summary;
    return diagnoseWorkflowResult(
      `Workflow run ${runId} diagnosis:\n\nRoot-cause analysis:\n${summary.summary}`,
      details
    );
  }

  // 4. No summarization possible or no logs returned
  const logSection = logText
    ? `\n\nLog tail:\n\n${logText.slice(-4000)}`
    : '\n\nNo log content found.';
  return diagnoseWorkflowResult(`Workflow run ${runId} diagnosis:${logSection}`, details);
}

/**
 * Create the diagnose_workflow_failure tool definition.
 *
 * @returns The tool definition.
 */
export function diagnoseWorkflowFailureToolFactory() {
  return defineTool({
    name: 'diagnose_workflow_failure',
    label: 'Diagnose Workflow Failure',
    description: DIAGNOSE_WORKFLOW_FAILURE_DESCRIPTION,
    promptSnippet: DIAGNOSE_WORKFLOW_FAILURE_PROMPT_SNIPPET,
    promptGuidelines: DIAGNOSE_WORKFLOW_FAILURE_PROMPT_GUIDELINES,
    parameters: diagnoseWorkflowFailureSchema,
    constrainedSampling: PREFER_STRICT_JSON_SCHEMA,
    namespace: PI_ACTION_NAMESPACE,
    annotations: READ_ONLY_ANNOTATIONS,
    outputSchema: diagnoseWorkflowOutputSchema,
    execute: withCancellation<
      DiagnoseWorkflowFailureToolParams,
      DiagnoseWorkflowFailureDetails,
      DiagnoseWorkflowFailureToolParams
    >({
      cancellationMessage: CANCELLATION_MESSAGE_DIAGNOSE_WORKFLOW_FAILURE,
      cancellationDetails: {
        run_url: '',
        summarized: false,
        summary: '',
      },
      errorDetails: () => ({
        run_url: '',
        summarized: false,
        summary: '',
      }),
      prepareParams: params => params,
      execute: (params, ctx) => executeDiagnoseWorkflowFailure(params, ctx as ExtensionToolContext),
    }),
  });
}
