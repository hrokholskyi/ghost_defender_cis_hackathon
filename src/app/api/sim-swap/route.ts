import { reportSimSwap } from "@/lib/bank";
import { handle, readJson } from "@/lib/http";
import { parseInput, simSwapSchema } from "@/lib/schemas";

export async function POST(request: Request): Promise<Response> {
  return handle(request, async () => reportSimSwap(parseInput(simSwapSchema, await readJson(request))));
}
