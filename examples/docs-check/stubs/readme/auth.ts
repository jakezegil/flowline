// Stub for the README's "../auth": every request belongs to tenant "acme".
export async function getSession(_req: Request): Promise<{ orgId: string; userId: string } | null> {
  return { orgId: "acme", userId: "user_1" };
}
