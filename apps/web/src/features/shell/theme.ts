import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#f2ff59", contrastText: "#211927" },
    background: { default: "#211927", paper: "#2a2330" },
    text: { primary: "#f0efed", secondary: "#c2bfb9" },
    error: { main: "#ff3b3b" },
    divider: "rgba(255,255,255,.08)",
  },
  typography: { fontFamily: "Inter, sans-serif", h1: { fontSize: "clamp(2.4rem, 4.2vw, 4rem)", fontWeight: 500, letterSpacing: "-.05em" },
    h2: { fontSize: "1.5rem", fontWeight: 500 },
    overline: { fontFamily: "Barlow Condensed, sans-serif", letterSpacing: ".12em", fontSize: 14 },
    button: { fontWeight: 600 } },
  shape: { borderRadius: 16 },
  components: {
    MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { borderRadius: 999, textTransform: "none", minHeight: 44 } } },
    MuiPaper: { defaultProps: { elevation: 0 }, styleOverrides: { root: { backgroundImage: "none", border: "1px solid rgba(255,255,255,.08)" } } },
    MuiChip: { styleOverrides: { root: { borderRadius: 999 } } },
    MuiCssBaseline: { styleOverrides: { body: { minWidth: 340 }, "::selection": { background: "#f2ff59", color: "#211927" } } },
  },
});
