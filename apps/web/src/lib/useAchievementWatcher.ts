import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { achievements, localDay, newlyEarned, type Achievement } from "./insights";
import { fetchInsights } from "./insightsApi";
import { fetchAchievements, unlockAchievements } from "./achievementsApi";
import { useToast } from "./toast";

// Module-level rather than refs: every page renders its own AppShell, so the
// watcher remounts on each navigation, and a ref would forget a badge that is
// mid-save and announce it twice.
const announced = new Set<string>();
let saving = false;

// Beyond this many at once, one toast lists them instead of a stack of them.
const GROUP_AFTER = 2;

/**
 * Announces a badge the moment it's earned, wherever you are in the app.
 *
 * The badges are recomputed from the same /api/insights the Stats page reads,
 * refreshed on focus and every couple of minutes while the tab is visible,
 * and compared with the server's record of what has already been unlocked.
 * A badge is toasted only after the server has stored it, so a failed save
 * retries on the next refresh rather than announcing it again.
 *
 * On the very first run everything already earned is recorded silently —
 * a year of history should not arrive as twenty toasts.
 */
export function useAchievementWatcher() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const insights = useQuery({
    queryKey: ["insights"],
    queryFn: fetchInsights,
    staleTime: 60_000,
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });
  const record = useQuery({
    queryKey: ["achievements"],
    queryFn: fetchAchievements,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!insights.data || !record.data || saving) return;
    const seeded = record.data.seeded;
    const fresh = newlyEarned(achievements(insights.data, localDay(new Date())), record.data.unlocked).filter(
      (badge) => !announced.has(badge.id),
    );
    if (seeded && fresh.length === 0) return;

    for (const badge of fresh) announced.add(badge.id);
    saving = true;
    unlockAchievements(fresh.map((badge) => badge.id))
      .then((next) => {
        queryClient.setQueryData(["achievements"], next);
        if (seeded) announce(fresh);
      })
      .catch(() => {
        for (const badge of fresh) announced.delete(badge.id);
      })
      .finally(() => {
        saving = false;
      });

    function announce(badges: Achievement[]) {
      const view = { label: "View", onClick: () => void navigate({ to: "/stats", hash: "trophies" }) };
      if (badges.length > GROUP_AFTER) {
        toast({
          variant: "achievement",
          title: `${badges.length} new trophies`,
          description: badges.map((badge) => badge.title).join(" · "),
          action: view,
        });
        return;
      }
      for (const badge of badges) {
        toast({
          variant: "achievement",
          title: `Unlocked: ${badge.title}`,
          description: badge.description,
          action: view,
        });
      }
    }
  }, [insights.data, record.data, queryClient, navigate, toast]);
}
