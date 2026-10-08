import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SeekStrip } from "./SeekStrip";

const flat = () => new Array<number>(50).fill(0);

function strip(props: Partial<React.ComponentProps<typeof SeekStrip>> = {}) {
  return render(
    <SeekStrip
      duration={100}
      currentTime={0}
      sprite={undefined}
      bookmarks={[]}
      visible
      onSeek={() => {}}
      {...props}
    />,
  );
}

describe("SeekStrip best part", () => {
  it("offers the button once a part has been replayed", async () => {
    const heatmap = flat();
    heatmap[20] = 5;
    const onJumpToBest = vi.fn();
    strip({ heatmap, onJumpToBest });

    await userEvent.click(screen.getByRole("button", { name: /best part/i }));
    expect(onJumpToBest).toHaveBeenCalledTimes(1);
  });

  it("hides the button when nothing has been replayed", () => {
    strip({ heatmap: flat(), onJumpToBest: () => {} });
    expect(screen.queryByRole("button", { name: /best part/i })).toBeNull();
  });

  it("hides the button when there is no handler", () => {
    const heatmap = flat();
    heatmap[20] = 5;
    strip({ heatmap });
    expect(screen.queryByRole("button", { name: /best part/i })).toBeNull();
  });
});

describe("SeekStrip heatmap bars", () => {
  it("draws nothing for buckets that were never watched", () => {
    const heatmap = flat();
    heatmap[3] = 4;
    heatmap[4] = 2;
    const { container } = strip({ heatmap });
    const bars = Array.from(container.querySelectorAll<HTMLElement>("div.rounded-t-sm"));

    expect(bars).toHaveLength(50);
    expect(bars[0].style.height).toBe("0%");
    expect(bars[3].style.height).toBe("100%");
    expect(bars[4].style.height).toBe("50%");
  });
});
