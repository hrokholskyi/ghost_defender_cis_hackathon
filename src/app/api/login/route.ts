import { login } from "@/lib/bank";
import { handle, readJson } from "@/lib/http";
import { loginSchema, parseInput } from "@/lib/schemas";

export async function POST(request: Request): Promise<Response> {
  return handle(request, async () => login(parseInput(loginSchema, await readJson(request))));
}
