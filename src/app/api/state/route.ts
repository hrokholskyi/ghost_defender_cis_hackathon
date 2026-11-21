import { handle } from "@/lib/http";
import { getSnapshot } from "@/lib/snapshot";

export async function GET(request: Request): Promise<Response> {
  return handle(request, () => getSnapshot());
}
