import { bearerToken, handle } from "@/lib/http";
import { executePayment } from "@/lib/payment-gateway";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(request, async () => {
    const { id } = await ctx.params;
    return executePayment(bearerToken(request), id);
  });
}
