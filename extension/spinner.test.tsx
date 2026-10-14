import { expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { SPINNER_FRAMES, useSpinnerFrame } from "./qa";

test("spinner animates only while active and stops on unmount", async () => {
  let toggle = (_active: boolean) => {};
  const frames: string[] = [];
  function Spinner() {
    const [active, setActive] = useState(false);
    toggle = setActive;
    const frame = useSpinnerFrame(active);
    frames.push(frame);
    return <text content={frame || "inactive"} />;
  }
  const view = await testRender(<Spinner />, { width: 20, height: 2 });
  try {
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("inactive");
    await act(async () => toggle(true));
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain(SPINNER_FRAMES[0]!);
    await act(async () => { await Bun.sleep(150); });
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain(SPINNER_FRAMES[1]!);
    await act(async () => toggle(false));
    const count = frames.length;
    await act(async () => { await Bun.sleep(150); });
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("inactive");
    expect(frames).toHaveLength(count);
    await act(async () => toggle(true));
  } finally {
    act(() => view.renderer.destroy());
  }
  const count = frames.length;
  await Bun.sleep(150);
  expect(frames).toHaveLength(count);
});
