import { findByProps } from "@vendetta/metro";
import { storage } from "@vendetta/plugin";
import { showToast } from "@vendetta/ui/toasts";

const AuthModule = findByProps("getToken");
const UploadModule = findByProps("promptToUpload");

const KEY_CHAN = "boostChan";
const KEY_LIMIT = "sizeLimitMb";

function getSetting(key: string, fallback: any) {
    return storage[key] !== undefined && storage[key] !== null ? storage[key] : fallback;
}

function bigEnough(files: File[]): boolean {
    const mb = getSetting(KEY_LIMIT, 0);
    if (mb === 0) return true;
    return files.some(f => f.size > mb * 1024 * 1024);
}

function currentChanId(): string | null {
    try {
        return window.location.pathname.match(/\/channels\/(?:\d+|@me)\/(\d+)/)?.[1] ?? null;
    } catch {
        return null;
    }
}

async function reupload(files: File[], originalChan: string) {
    const destChan = (getSetting(KEY_CHAN, "") as string).trim();
    if (!destChan) {
        showToast("UploadRedirect: set a boost channel ID in settings first", { type: "danger" });
        return;
    }

    showToast("UploadRedirect: uploading...");

    const fd = new FormData();
    files.forEach((f, i) => fd.append(`files[${i}]`, f, f.name));
    fd.append("payload_json", JSON.stringify({
        content: "",
        attachments: files.map((f, i) => ({ id: `${i}`, filename: f.name }))
    }));

    let resp: Response;
    try {
        resp = await fetch(`/api/v9/channels/${destChan}/messages`, {
            method: "POST",
            headers: { Authorization: AuthModule.getToken() },
            body: fd
        });
    } catch (e: any) {
        showToast("UploadRedirect: network error — " + e.message, { type: "danger" });
        return;
    }

    if (!resp.ok) {
        const body = await resp.json().catch(() => ({ message: resp.statusText }));
        showToast(`UploadRedirect: failed ${resp.status}: ${body.message}`, { type: "danger" });
        return;
    }

    const json = await resp.json();
    if (!json.attachments?.length) {
        showToast("UploadRedirect: no attachments returned", { type: "danger" });
        return;
    }

    const redownloaded = await Promise.all(json.attachments.map(async (a: any, i: number) => {
        const blob = await fetch(a.url).then(r => r.blob());
        return new File([blob], files[i]?.name ?? "file", { type: blob.type });
    }));

    UploadModule.promptToUpload(redownloaded, { id: originalChan }, 0);
    showToast("UploadRedirect: done!", { type: "success" });
}

const attached: [EventTarget, string, EventListener][] = [];
const doneInputs = new WeakSet<HTMLInputElement>();
let mo: MutationObserver | null = null;

function on(el: EventTarget, ev: string, fn: EventListener) {
    el.addEventListener(ev, fn, true);
    attached.push([el, ev, fn]);
}

function hookInput(el: HTMLInputElement) {
    if (doneInputs.has(el)) return;
    doneInputs.add(el);
    on(el, "change", (e: Event) => {
        const inp = e.target as HTMLInputElement;
        const picked = Array.from(inp.files ?? []);
        if (!picked.length || !bigEnough(picked)) return;
        e.stopImmediatePropagation();
        try {
            inp.value = "";
            Object.defineProperty(inp, "files", { get: () => new DataTransfer().files, configurable: true });
        } catch { }
        const ch = currentChanId();
        if (ch) reupload(picked, ch);
    });
}

export default {
    onLoad() {
        const root = document.getElementById("app-mount") ?? document.body;

        on(root, "drop", (e: Event) => {
            const de = e as DragEvent;
            const files = Array.from(de.dataTransfer?.files ?? []);
            if (!files.length || !bigEnough(files)) return;
            e.preventDefault();
            de.stopImmediatePropagation();
            const ch = currentChanId();
            if (ch) reupload(files, ch);
        });

        on(root, "paste", (e: Event) => {
            const ce = e as ClipboardEvent;
            const files = Array.from(ce.clipboardData?.files ?? []);
            if (!files.length || !bigEnough(files)) return;
            e.preventDefault();
            ce.stopImmediatePropagation();
            const ch = currentChanId();
            if (ch) reupload(files, ch);
        });

        document.querySelectorAll<HTMLInputElement>('input[type="file"]').forEach(el => hookInput(el));

        mo = new MutationObserver(muts => {
            for (const m of muts) for (const n of m.addedNodes) {
                if (n instanceof HTMLInputElement && n.type === "file") hookInput(n);
                else if (n instanceof HTMLElement) n.querySelectorAll<HTMLInputElement>('input[type="file"]').forEach(el => hookInput(el));
            }
        });
        mo.observe(document.body, { childList: true, subtree: true });
    },

    onUnload() {
        attached.forEach(([el, ev, fn]) => el.removeEventListener(ev, fn, true));
        attached.length = 0;
        mo?.disconnect();
        mo = null;
    }
};
