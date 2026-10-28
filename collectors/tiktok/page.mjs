// What the TikTok DM collector reads inside the inbox page (https://www.tiktok.com/messages).
// These functions run in the browser through page.evaluate, so they must be self-contained.
//
// TikTok publishes no markup contract, so every selector below is a list of fallbacks (stable
// data-e2e attributes first, then class-name fragments), and any of them can be replaced without a
// code change in ~/.strout-vault/tiktok-selectors.json (same keys). `node collector.mjs --probe`
// reports how many elements each selector matches on the live page, with no message text, which
// is what to look at when TikTok changes its inbox.

export const DEFAULT_SELECTORS = {
  // Conversation rows in the left-hand list.
  listItem: '[data-e2e="chat-list-item"], [class*="DivItemWrapper"], [class*="ConversationItem"]',
  listUnread: '[class*="Unread"], [class*="unread"], [class*="Badge"], [class*="RedDot"], [data-e2e*="unread"]',
  // The open conversation's header: the other person's @username and display name.
  headerUsername: '[data-e2e="chat-uniqueid"], [class*="ChatHeader"] [class*="UniqueId"], [class*="ChatHeader"] a[href^="/@"]',
  headerNickname: '[data-e2e="chat-nickname"], [class*="ChatHeader"] [class*="Nickname"]',
  // Messages and the time labels between them, in page order.
  messageItem: '[data-e2e="chat-item"], [class*="DivChatItemWrapper"], [class*="MessageItem"]',
  timeDivider: '[class*="TimeContainer"], [class*="DivTimeContainer"], [class*="ChatTime"], [data-e2e="chat-time"]',
  messageText: '[class*="TextContainer"], [class*="MessageText"], [class*="PText"], p',
  messageScroller: '[class*="ChatMain"], [class*="DivChatMainContent"], [class*="MessageList"], [data-e2e="chat-main"]',
  // Message requests (people who do not follow back), when TikTok shows them as a separate list.
  requestsEntry: '[data-e2e="message-request"], [class*="RequestEntry"], [class*="MessageRequest"]',
  loginMarker: '[data-e2e="top-login-button"], [data-e2e="login-button"], form[action*="login"]',
};

/** The conversation list: one row per conversation, as the list shows it. Runs in the page. */
export function readList(sel) {
  const timeLike = (s) => /^(\d+\s*(s|m|h|d|w)\b.*|just now|today.*|yesterday.*|\d{1,2}[:/.-]\d{1,2}.*|(mon|tue|wed|thu|fri|sat|sun)\w*.*|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\.? \d.*)$/i.test(s.trim());
  return [...document.querySelectorAll(sel.listItem)].map((el, index) => {
    // Text from the row's innermost elements, in order: nickname, preview, time. Reading leaves rather
    // than innerText keeps inline neighbours apart. An unread badge ("1", "99+") is not text.
    const leaves = [...el.querySelectorAll("*")].filter((e) => ![...e.children].some((c) => (c.textContent ?? "").trim()));
    const lines = leaves.map((e) => (e.textContent ?? "").trim()).filter((s) => s && !/^\d{1,3}\+?$/.test(s));
    const time = [...lines].reverse().find(timeLike) ?? null;
    const rest = lines.filter((l) => l !== time);
    const img = el.querySelector("img");
    let avatar = img?.getAttribute("src") ?? "";
    try {
      avatar = new URL(avatar, location.href).pathname;
    } catch {
      /* keep as is */
    }
    return {
      index,
      nickname: rest[0] ?? null,
      preview: rest.slice(1).join(" ") || null,
      time_label: time,
      unread: !!el.querySelector(sel.listUnread),
      avatar,
    };
  });
}

/** The open conversation: who it is with and its messages in order, oldest first. Runs in the page. */
export function readConversation(sel, account) {
  const first = (selector, root = document) => {
    for (const s of selector.split(",")) {
      const el = root.querySelector(s.trim());
      if (el) return el;
    }
    return null;
  };
  const userEl = first(sel.headerUsername);
  let username = (userEl?.getAttribute("href") ?? "").match(/\/@([^/?#]+)/)?.[1] ?? (userEl?.textContent ?? "").trim();
  username = username.replace(/^@/, "").trim().toLowerCase();
  const nickname = (first(sel.headerNickname)?.textContent ?? "").trim() || null;
  const me = String(account ?? "").replace(/^@/, "").toLowerCase();

  const scroller = first(sel.messageScroller);
  const box = scroller?.getBoundingClientRect();
  const center = box ? box.left + box.width / 2 : window.innerWidth / 2;
  const nodes = [...document.querySelectorAll(`${sel.messageItem}, ${sel.timeDivider}`)];
  // An item inside another matched item (wrapper + inner) is read once, through the outer one.
  const top = nodes.filter((n) => !nodes.some((o) => o !== n && o.contains(n)));
  const messages = [];
  let label = null;
  for (const n of top) {
    if (n.matches(sel.timeDivider) && !n.matches(sel.messageItem)) {
      label = (n.textContent ?? "").trim() || label;
      continue;
    }
    const links = [...n.querySelectorAll('a[href*="/@"]')].map((a) => (a.getAttribute("href") ?? "").match(/\/@([^/?#]+)/)?.[1]?.toLowerCase());
    let fromMe;
    if (me && links.includes(me)) fromMe = true;
    else if (username && links.includes(username)) fromMe = false;
    else if (/(^|[^a-z])(my|self|own|right)/i.test(String(n.className))) fromMe = true;
    else {
      const content = first(sel.messageText, n) ?? n;
      const r = content.getBoundingClientRect();
      fromMe = r.left + r.width / 2 > center;
    }
    const video = [...n.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]')].map((a) => new URL(a.getAttribute("href"), location.href).href)[0] ?? null;
    const images = [...n.querySelectorAll("img")].filter((img) => !img.closest('a[href^="/@"], a[href*="tiktok.com/@"]') && (img.naturalWidth || img.width) > 48);
    const textEl = first(sel.messageText, n);
    let text = (textEl ?? n).innerText ?? "";
    text = text.split("\n").map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== (nickname ?? "").toLowerCase()).join("\n");
    if (!text && !video && !images.length) continue;
    messages.push({
      time_label: label,
      from_me: fromMe,
      text: video && !textEl ? "" : text,
      shared_url: video,
      attachments: video ? [] : images.map(() => ({ filename: "image", mime: "image/*", size: null })),
    });
  }
  return { username, nickname, messages, itemCount: top.length };
}

/** Counts per selector and a tag/class skeleton of the inbox, with no text: for --probe and failure notes. Runs in the page. */
export function probePage(sel) {
  const counts = {};
  for (const [k, v] of Object.entries(sel)) {
    try {
      counts[k] = document.querySelectorAll(v).length;
    } catch {
      counts[k] = "invalid selector";
    }
  }
  const e2e = [...new Set([...document.querySelectorAll("[data-e2e]")].map((e) => e.getAttribute("data-e2e")))].sort();
  const skeleton = (el, depth) => {
    if (!el || depth > 7) return null;
    const cls = String(el.className && typeof el.className === "string" ? el.className : "")
      .split(/\s+/)
      .filter((c) => /[A-Z]/.test(c) && c.length < 60)
      .slice(0, 2)
      .join(".");
    const tag = `${el.tagName.toLowerCase()}${el.getAttribute("data-e2e") ? `[data-e2e=${el.getAttribute("data-e2e")}]` : ""}${cls ? `.${cls}` : ""}`;
    const kids = [...el.children].slice(0, 6).map((c) => skeleton(c, depth + 1)).filter(Boolean);
    return kids.length ? { [tag]: kids } : tag;
  };
  const main = document.querySelector("main") ?? document.body;
  return { url: location.pathname, counts, dataE2e: e2e, skeleton: skeleton(main, 0) };
}
