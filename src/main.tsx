import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/app/App";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

// NOT StrictMode's double-mount by accident: the editor boot is cancel-safe (see
// `mountEditor` and the effect that calls it), and running it twice in development is a
// useful check that it stays that way.
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
