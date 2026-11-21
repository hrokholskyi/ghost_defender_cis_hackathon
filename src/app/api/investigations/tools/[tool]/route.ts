import { handleToolRequest } from "@/lib/investigator/devin/tool-endpoint";

type Context = { params: Promise<{ tool: string }> };

// handleToolRequest reads the Authorization header first, which keeps the route dynamic.
export async function GET(request: Request, ctx: Context): Promise<Response> {
  const { tool } = await ctx.params;
  return handleToolRequest(request, tool);
}

export async function POST(request: Request, ctx: Context): Promise<Response> {
  const { tool } = await ctx.params;
  return handleToolRequest(request, tool);
}
