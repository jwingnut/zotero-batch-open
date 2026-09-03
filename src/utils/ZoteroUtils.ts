import { PLATFORM_VERSION_CREATE_XUL, XUL_NAMESPACE } from "@/constants/Menus";

/** Small DOM/platform helpers shared by the legacy and MenuManager menu paths. */
export class ZoteroUtils {
  /**
   * Create a XUL element with attributes.
   * Uses createXULElement for Zotero 102+ with fallback to createElementNS.
   */
  static createXULElement(
    doc: Document,
    tagName: string,
    attributes: Record<string, string | (() => void)> = {},
  ): Element {
    const element =
      Zotero.platformMajorVersion >= PLATFORM_VERSION_CREATE_XUL
        ? doc.createXULElement(tagName)
        : doc.createElementNS(XUL_NAMESPACE, tagName);

    for (const [key, value] of Object.entries(attributes)) {
      if (key === "oncommand" && typeof value === "function") {
        element.addEventListener("command", value);
      } else {
        element.setAttribute(key, String(value));
      }
    }

    return element;
  }

  /** Check if the Zotero 8+ MenuManager API is available. */
  static hasNewMenuAPI(): boolean {
    return typeof Zotero.MenuManager?.registerMenu === "function";
  }
}
