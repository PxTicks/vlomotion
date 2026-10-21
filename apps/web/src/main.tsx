import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CssBaseline, ThemeProvider } from "@mui/material";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/barlow-condensed/latin-600.css";
import { App } from "./features/shell/App";
import { theme } from "./features/shell/theme";

createRoot(document.getElementById("root")!).render(
  <StrictMode><ThemeProvider theme={theme}><CssBaseline /><App /></ThemeProvider></StrictMode>,
);
