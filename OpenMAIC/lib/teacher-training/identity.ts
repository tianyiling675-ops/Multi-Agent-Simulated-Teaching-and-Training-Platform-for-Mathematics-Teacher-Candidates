import { createHash, randomBytes } from 'node:crypto';

/** Anonymous device identity, not a cloud account. Only an unguessable bearer
 * cookie is accepted. Public record IDs and client owner/learner headers are
 * never credentials. Keep this seam replaceable by the host's verified login.
 */
export function trainingOwner(request: Request, responseHeaders: Headers) {
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('training_identity='))
    ?.slice('training_identity='.length);
  const token = cookie && /^[a-f0-9]{64}$/.test(cookie) ? cookie : randomBytes(32).toString('hex');
  if (token !== cookie) {
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    responseHeaders.append(
      'Set-Cookie',
      `training_identity=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`,
    );
  }
  return `device:${createHash('sha256').update(token).digest('hex')}`;
}
