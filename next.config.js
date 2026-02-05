/** @type {import('next').NextConfig} */
const withPWA = require("next-pwa")({
    dest: "public",
    register: true,
    skipWaiting: true,
    disable: process.env.NODE_ENV === "development",
    buildExcludes: [/middleware-manifest\.json$/, /_next\/app-build-manifest\.json$/, /_next\/static\/chunks\/pages\/_error\.js$/],
});

const nextConfig = {};

module.exports = withPWA(nextConfig);
