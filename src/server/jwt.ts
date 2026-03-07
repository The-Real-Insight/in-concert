/**
 * Extract user from JWT payload (no verification - auth is handled upstream).
 * Used when request body lacks user details (e.g. tri-portal via tri-server).
 */
export function getUserFromAuthHeader(authHeader: string | undefined): {
  email?: string;
  firstName?: string;
  lastName?: string;
} | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.slice(7);
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json) as Record<string, unknown>;
    const email = payload.email as string | undefined;
    const firstName = payload.firstName as string | undefined;
    const lastName = payload.lastName as string | undefined;
    if (!email && !firstName && !lastName) return null;
    return { email, firstName, lastName };
  } catch {
    return null;
  }
}
