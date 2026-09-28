// Declares the cascade-layer order first, so the app's resets sit below Flowkit's styles.
import "./layers.css";
import "@flowkit/react/styles.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { App } from "./app";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

// A data router (so the editor page can block leaving with unsaved changes, via useBlocker);
// the app's own <Routes> still do the matching under one catch-all route.
const router = createBrowserRouter([{ path: "*", element: <App /> }]);

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
