import { bearerToken, handle, readJson } from "@/lib/http";
import { parseInput, verificationResponseSchema } from "@/lib/schemas";
import { respondToVerification } from "@/lib/verification";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(request, async () => {
    const { id } = await ctx.params;
    const input = parseInput(verificationResponseSchema, await readJson(request));
    return respondToVerification(bearerToken(request), id, input);
  });
}
