"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { flushSync } from "react-dom";

/**
 * 轻量 View Transitions 封装（Modern Web Guidance: same-document-transitions）。
 *
 * Next.js App Router 是 SPA 软导航，无法用 `@view-transition { navigation: auto }`
 * （那仅对整文档 MPA 导航生效），故采用同文档方式：用 `document.startViewTransition`
 * 包裹 `router.push`，并在回调内用 `flushSync` 同步提交 DOM，使浏览器能在旧/新
 * 快照之间生成过渡。不支持该 API 的浏览器会直接跳过，无副作用。
 *
 * 用法：在 layout 中用 <ViewTransitions> 包住 children，任意客户端组件里
 * `const { navigate } = useViewTransition();` 然后 `navigate("/path")` 即可。
 */

type StartViewTransition = (cb: () => void) => unknown;

const ViewTransitionContext = createContext<{
  navigate: (href: string) => void;
}>({ navigate: () => {} });

export function ViewTransitions({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pendingRef = useRef(false);

  const navigate = useCallback(
    (href: string) => {
      const doc = typeof document !== "undefined" ? document : null;
      const startVT = doc?.startViewTransition as
        | StartViewTransition
        | undefined;

      if (!startVT) {
        router.push(href);
        return;
      }

      // 回退：若已有过渡进行中，直接导航避免竞态
      if (pendingRef.current) {
        router.push(href);
        return;
      }
      pendingRef.current = true;
      startVT(() => {
        flushSync(() => {
          router.push(href);
        });
        pendingRef.current = false;
      });
    },
    [router],
  );

  return (
    <ViewTransitionContext.Provider value={{ navigate }}>
      {children}
    </ViewTransitionContext.Provider>
  );
}

export function useViewTransition() {
  return useContext(ViewTransitionContext);
}
