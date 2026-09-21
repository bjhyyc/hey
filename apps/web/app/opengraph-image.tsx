import { ImageResponse } from "next/og";

// The link preview. No photograph is available that we hold the rights to
// show, so the card is the brand line on the site's own palette - the same
// thing a visitor sees first on the page.
export const alt = "Hey — 用你家宠物的照片，做一只会动的桌面宠物";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 84px",
          background: "#fcfaf7",
          color: "#0d0d0d",
          fontFamily: "sans-serif"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ width: 22, height: 22, borderRadius: 999, background: "#ffd184" }} />
          <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: -0.5 }}>Hey</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ fontSize: 76, fontWeight: 700, letterSpacing: -2, lineHeight: 1.05 }}>Hey, I Really Miss You.</div>
          <div style={{ fontSize: 40, color: "rgba(13,13,13,0.72)" }}>用你家宠物的照片，做一只会动的桌面宠物</div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 26, color: "rgba(13,13,13,0.52)" }}>
          <div>把思念带回桌面</div>
          <div>www.heyirmy.com</div>
        </div>
      </div>
    ),
    { ...size }
  );
}
