import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { VolumeReplay } from "./VolumeReplay.js";
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main>
      <VolumeReplay />
    </main>
  </StrictMode>,
);
