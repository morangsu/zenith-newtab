/* 书签读取：只在用户显式授予 bookmarks 权限后调用。输出扁平候选列表。 */
import { ext } from './util.js';

export async function flattenBookmarks(limit = 3000) {
  if (!ext || !ext.bookmarks) return [];
  const tree = await ext.bookmarks.getTree();
  const out = [];

  (function walk(nodes) {
    for (const node of nodes) {
      if (out.length >= limit) return;
      if (node.url && /^https?:/i.test(node.url)) {
        out.push({ title: node.title || node.url, url: node.url, kind: '书签' });
      }
      if (node.children) walk(node.children);
    }
  })(tree);

  return out;
}
