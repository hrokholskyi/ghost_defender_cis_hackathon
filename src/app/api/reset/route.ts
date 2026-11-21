import { handle } from "@/lib/http";
import { resetSimulator } from "@/lib/scenarios";

export async function POST(request: Request): Promise<Response> {
  return handle(request, () => resetSimulator());
}
