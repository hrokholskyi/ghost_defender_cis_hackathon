import { addBeneficiary } from "@/lib/bank";
import { bearerToken, handle, readJson } from "@/lib/http";
import { addBeneficiarySchema, parseInput } from "@/lib/schemas";

export async function POST(request: Request): Promise<Response> {
  return handle(request, async () =>
    addBeneficiary(bearerToken(request), parseInput(addBeneficiarySchema, await readJson(request))),
  );
}
