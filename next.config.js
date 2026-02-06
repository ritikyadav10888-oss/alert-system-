/** @type {import('next').NextConfig} */
const withPWA = require("next-pwa")({
    dest: "public",
    register: true,
    skipWaiting: true,
    disable: false, // Enable PWA in all environments for device installation
    sw: "sw.js",
    buildExcludes: [
        /middleware-manifest\.json$/,
        /app-build-manifest\.json$/,
        /middleware-build-manifest\.json$/,
        /_next\/static\/.*manifest\.json$/,
        /_next\/static\/.*build-manifest\.json$/,
        /.*\.map$/
    ],
    runtimeCaching: [
        {
            urlPattern: /^https?.*/,
            handler: 'NetworkFirst',
            options: {
                cacheName: 'offlineCache',
                expiration: {
                    maxEntries: 200,
                },
            },
        },
    ],
});

const nextConfig = {};

module.exports = withPWA(nextConfig);
