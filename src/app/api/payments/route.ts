import { bearerToken, handle, readJson } from "@/lib/http";
import { requestTransfer } from "@/lib/payment-gateway";

/** The gateway validates the body itself, after the session checks, so a restricted session is refused first. */
export async function POST(request: Request): Promise<Response> {
  return handle(request, async () => {
    const token = bearerToken(request);
    let body: unknown;
    try {
      body = await readJson(request);
    } catch {
      body = null;
    }
    return requestTransfer(token, body);
  });
}
