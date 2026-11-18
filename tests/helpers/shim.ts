// Re-exports React, React DOM and React Router through the same Vite loader as the app code, so both use the same copies.
export { default as React } from "react";
export { renderToString } from "react-dom/server";
export { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
