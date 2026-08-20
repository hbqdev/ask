/** @type {import('next').NextConfig} */
const nextConfig = {
  // Native-addon packages must stay external: bundling rewrites their module
  // root, so their platform-specific .node loader can no longer find its own
  // prebuilt binary ("Could not find native build for platform=...").
  serverExternalPackages: [
    'onnxruntime-node',
    '@huggingface/transformers',
    'couchbase'
  ],
  // Reverse proxy for PostHog to reduce tracking-blocker interception.
  skipTrailingSlashRedirect: true,
  // Security response headers. The app previously returned none. These are the
  // zero-feature-risk set — they change no rendering behaviour:
  //   - HSTS: force HTTPS on the public tunnel (ignored on plain-http localhost)
  //   - frame-ancestors 'none' + X-Frame-Options: clickjacking
  //   - nosniff: no MIME-sniffing of responses
  //   - Referrer-Policy: do not leak full URLs cross-origin
  //   - Permissions-Policy: deny powerful APIs the app never uses
  //
  // A full Content-Security-Policy (an `img-src`/`connect-src` allowlist) is
  // still not set, because the app legitimately renders images from arbitrary
  // domains (search results, the news widget). The prompt-injection image-
  // EXFILTRATION channel it would have closed is instead handled at the render
  // layer: model-authored markdown images in the ANSWER are rendered as
  // click-through links, not auto-loading <img> (components/message.tsx,
  // AnswerImage), so the zero-click exfiltration path is gone without a CSP that
  // would break the legitimate image components.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains'
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin'
          },
          {
            key: 'Permissions-Policy',
            // microphone=(self): voice dictation needs getUserMedia; geolocation=(self):
            // the weather widget needs the Geolocation API — both on our OWN origin only
            // (still denied to embedded third parties, and the browser still prompts the
            // user). camera/payment stay fully denied — the app doesn't use them.
            value: 'camera=(), microphone=(self), geolocation=(self), payment=()'
          }
        ]
      }
    ]
  },
  async rewrites() {
    return [
      {
        source: '/relay/static/:path*',
        destination: 'https://us-assets.i.posthog.com/static/:path*'
      },
      {
        source: '/relay/array/:path*',
        destination: 'https://us-assets.i.posthog.com/array/:path*'
      },
      {
        source: '/relay/:path*',
        destination: 'https://us.i.posthog.com/:path*'
      }
    ]
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'i.ytimg.com',
        port: '',
        pathname: '/vi/**'
      },
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
        port: '',
        pathname: '/a/**' // Google user content often follows this pattern
      },
      {
        protocol: 'https',
        hostname: 'imgs.search.brave.com',
        port: '',
        pathname: '/**' // Brave search cached images
      },
      {
        protocol: 'https',
        hostname: 'www.google.com',
        port: '',
        pathname: '/s2/favicons/**' // Google Favicon API
      }
    ]
  }
}

export default nextConfig
