"use client";

import { WavyBackground } from "../src/components/ui/wavy-background";

export default function WavyLayer() {
  return (
    <WavyBackground
      colors={["#93c5fd", "#6ee7b7", "#a5b4fc", "#7dd3fc", "#86efac"]}
      backgroundFill="#e8f0f8"
      blur={8}
      speed="slow"
      waveOpacity={0.45}
      containerClassName="wavy-fixed-container"
    />
  );
}
