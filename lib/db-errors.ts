/**
 * True for Prisma's unique-constraint error (code P2002). With the SQLite driver adapter this
 * arrives as a PrismaClientKnownRequestError carrying that code.
 */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}
