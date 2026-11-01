import { handleTrainingRequest } from '@/lib/teacher-training/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
type Context = { params: Promise<{ path: string[] }> };
async function handle(request: Request, context: Context) {
  return handleTrainingRequest(request, (await context.params).path);
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
