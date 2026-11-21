import { handle } from "@/lib/http";
import { scenarioIdSchema, parseInput } from "@/lib/schemas";
import { startScenario } from "@/lib/scenarios";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(request, async () => {
    const { id } = await ctx.params;
    return startScenario(parseInput(scenarioIdSchema, id.toUpperCase()));
  });
}
