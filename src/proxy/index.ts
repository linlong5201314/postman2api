import { db } from "../db/index";
import { requestLogs } from "../db/schema";
import type { NewRequestLog } from "../db/schema";
import type { ChatCompletionRequest } from "../provider/base";
import { routeRequest } from "./router";
import { pool } from "./pool";
import { broadcast } from "../ws/index";
import { publicError, redactSensitive } from "../utils/redact";

export async function handleChatCompletion(
  body: ChatCompletionRequest,
  signal?: AbortSignal,
): Promise<Response> {
  const stream = body.stream ?? false;
  body.signal = signal;

  try {
    const { result, account, durationMs } = await routeRequest(body, stream);

    if (result.success && result.stream) {
      return wrapStream(result.stream, {
        accountId: account.id,
        model: body.model,
        durationMs,
        promptTokens: result.promptTokens || 0,
        completionTokens: result.completionTokens || 0,
        totalTokens: result.tokensUsed || 0,
        signal,
      });
    }

    if (result.success && result.response) {
      pool.trackRequestEnd(account.id);
      await recordRequest({
        accountId: account.id,
        model: body.model,
        promptTokens: result.promptTokens || 0,
        completionTokens: result.completionTokens || 0,
        totalTokens: result.tokensUsed || 0,
        status: "success",
        durationMs,
      });

      return new Response(JSON.stringify(result.response), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Non-success
    pool.trackRequestEnd(account.id);
    await recordRequest({
      accountId: account.id,
      model: body.model,
      status: "error",
      durationMs,
      errorMessage: result.error || "Unknown error",
    });

    return errorResponse(publicError(result.error, "Upstream request failed"), 503);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await recordRequest({
      model: body.model,
      status: "error",
      durationMs: 0,
      errorMessage: errMsg,
    });

    if (errMsg.includes("No active accounts")) {
      return errorResponse(publicError(errMsg, "No account is currently available"), 503);
    }

    return errorResponse("Internal request failure", 500);
  }
}

function wrapStream(
  stream: ReadableStream<Uint8Array>,
  ctx: {
    accountId: number;
    model: string;
    durationMs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    signal?: AbortSignal;
  },
): Response {
  let finalized = false;
  let reader: ReturnType<typeof stream.getReader> | undefined;
  const startedAt = Date.now() - ctx.durationMs;

  const finalize = async (status: "success" | "error", error?: unknown) => {
    if (finalized) return;
    finalized = true;
    pool.trackRequestEnd(ctx.accountId);
    await recordRequest({
      accountId: ctx.accountId,
      model: ctx.model,
      promptTokens: status === "success" ? ctx.promptTokens : 0,
      completionTokens: status === "success" ? ctx.completionTokens : 0,
      totalTokens: status === "success" ? ctx.totalTokens : 0,
      status,
      durationMs: Date.now() - startedAt,
      errorMessage: error ? (error instanceof Error ? error.message : String(error)) : undefined,
    });
  };

  const wrappedStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        await finalize("success");
        controller.close();
      } catch (err) {
        await finalize("error", err);
        controller.error(err);
      }
    },
    async cancel() {
      if (reader) {
        await reader.cancel().catch(() => {});
      } else {
        await stream.cancel().catch(() => {});
      }
      await finalize("error", "Client disconnected");
    },
  });

  return new Response(wrappedStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

async function recordRequest(entry: NewRequestLog): Promise<void> {
  try {
    await db.insert(requestLogs).values({
      ...entry,
      createdAt: new Date(),
    });
    broadcast({ type: "request_completed", data: { status: entry.status, model: entry.model } });
  } catch (err) {
    console.error("[proxy] Failed to log request:", redactSensitive(err));
  }
}

function errorResponse(message: string, status: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: status === 503 ? "no_available_account" : "internal_error",
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

export { pool };
