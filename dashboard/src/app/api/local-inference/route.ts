import { readLocalInferenceUsage } from '@/lib/local-inference';

export const dynamic = 'force-dynamic';

export async function GET() {
  const snapshot = readLocalInferenceUsage();
  if (!snapshot) {
    // No local-model calls logged yet. The component renders this as "no data yet".
    return Response.json(
      { error: 'No local inference logged yet.' },
      { status: 503 },
    );
  }
  return Response.json(snapshot);
}
