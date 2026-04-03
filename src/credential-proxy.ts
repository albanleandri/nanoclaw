/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Auth mode priority (first match wins):
 *   1. API key:    ANTHROPIC_API_KEY in .env — injects x-api-key on every request.
 *   2. .env OAuth: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_AUTH_TOKEN in .env.
 *   3. Host OAuth: ~/.claude/.credentials.json — uses the host Claude Code token,
 *                  auto-refreshing it when it expires. This lets containers share
 *                  the host's Claude subscription instead of paying per-token API rates.
 *
 * Credentials are re-read from .env on every request so updates take
 * effect immediately without restarting NanoClaw.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { getValidClaudeOAuthToken } from './claude-credentials.js';

type AuthMode = 'api-key' | 'oauth';

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  // Read once at startup for the upstream URL and initial log
  const initialSecrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);
  const initialAuthMode: AuthMode = initialSecrets.ANTHROPIC_API_KEY
    ? 'api-key'
    : 'oauth';
  const upstreamUrl = new URL(
    initialSecrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // Re-read credentials on every request so updates to .env take effect
      // immediately without restarting NanoClaw.
      const secrets = readEnvFile([
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
      ]);
      const authMode: AuthMode = secrets.ANTHROPIC_API_KEY
        ? 'api-key'
        : 'oauth';
      const oauthToken =
        secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: inject Bearer token and ensure the oauth-2025-04-20 beta
          // flag is present. Without that flag the API returns 401 "OAuth
          // authentication is currently not supported."
          // Priority: .env token > ~/.claude/.credentials.json (host Claude token)
          const resolvedToken =
            oauthToken || (await getValidClaudeOAuthToken());
          delete headers['x-api-key'];
          delete headers['authorization'];
          if (resolvedToken) {
            headers['authorization'] = `Bearer ${resolvedToken}`;
            // Append oauth beta flag if not already present.
            // Normalise to a string first — Node may parse repeated headers as string[].
            const rawBeta = headers['anthropic-beta'];
            const beta = Array.isArray(rawBeta)
              ? rawBeta.join(',')
              : ((rawBeta as string | undefined) ?? '');
            if (!beta.includes('oauth-2025-04-20')) {
              headers['anthropic-beta'] = beta
                ? `${beta},oauth-2025-04-20`
                : 'oauth-2025-04-20';
            }
          } else {
            logger.warn(
              { url: req.url },
              'OAuth mode: no token available — request will reach upstream unauthenticated',
            );
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info(
        { port, host, authMode: initialAuthMode },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}
