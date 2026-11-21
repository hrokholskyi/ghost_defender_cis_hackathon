import { handle } from "@/lib/http";
import { nextScenarioStep } from "@/lib/scenarios";

export async function POST(request: Request): Promise<Response> {
  return handle(request, () => nextScenarioStep());
}
