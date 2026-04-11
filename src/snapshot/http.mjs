import http from "node:http";

export function postJson(
  port,
  csrfToken,
  method,
  payload,
  timeoutMs,
  deps
) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const request = deps.httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: `${deps.extensionServerService}/${method}`,
        method: "POST",
        headers: {
          "x-codeium-csrf-token": csrfToken,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          let parsedBody = null;
          try {
            parsedBody = rawBody ? JSON.parse(rawBody) : null;
          } catch {
            parsedBody = rawBody || null;
          }

          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            statusCode: response.statusCode,
            body: parsedBody,
          });
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", () => resolve({ ok: false, statusCode: null, body: null }));
    request.write(body);
    request.end();
  });
}

export function subscribeTopicInitialState(
  port,
  csrfToken,
  topic,
  timeoutMs,
  deps
) {
  return new Promise((resolve) => {
    const payload = deps.frameConnectJson({ topic });
    const request = deps.httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: `${deps.extensionServerService}/SubscribeToUnifiedStateSyncTopic`,
        method: "POST",
        headers: {
          "x-codeium-csrf-token": csrfToken,
          "content-type": "application/connect+json",
          "content-length": payload.length,
        },
      },
      (response) => {
        const chunks = [];
        let settled = false;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          const parsed = deps.parseConnectJsonResponse(Buffer.concat(chunks));
          resolve({
            ok: response.statusCode === 200 && Boolean(parsed),
            statusCode: response.statusCode,
            body: parsed,
          });
          request.destroy();
        };

        response.on("data", (chunk) => {
          chunks.push(chunk);
          finish();
        });
        response.on("end", finish);
        setTimeout(finish, timeoutMs);
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", () => resolve({ ok: false, statusCode: null, body: null }));
    request.write(payload);
    request.end();
  });
}

export const defaultHttpRequest = http.request;
