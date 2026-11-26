import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import GithubSlugger from 'github-slugger';
import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toString } from 'mdast-util-to-string';
import { gfm } from 'micromark-extension-gfm';

function* walk(node: Nodes): Generator<Nodes> {
  yield node;
  if ('children' in node) for (const child of node.children) yield* walk(child);
}

function readDocument(path: string) {
  const content = readFileSync(path, 'utf8');
  const markdown = content.replace(/^---\n[\s\S]*?\n---\n/, '');
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();
  const links: string[] = [];
  for (const node of walk(tree)) {
    if (node.type === 'heading') anchors.add(slugger.slug(toString(node)));
    if (node.type === 'html') {
      for (const match of node.value.matchAll(/\s(?:id|name)=["']([^"']+)["']/gi)) anchors.add(match[1]!);
    }
    if (node.type === 'link' || node.type === 'image' || node.type === 'definition') links.push(node.url);
  }
  return { content, anchors, links };
}

export function verifyMarkdown(root: string, files: string[]): string[] {
  const errors: string[] = [];
  const documents = new Map(files.map(file => [resolve(root, file), readDocument(resolve(root, file))]));
  for (const [source, { content, links }] of documents) {
    const file = relative(root, source);
    if (content.includes('\r') || !content.endsWith('\n') || content.endsWith('\n\n')) {
      errors.push(`${file}: use LF and end the file with exactly one newline`);
    }
    for (const link of links) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link)) continue;
      try {
        const [location, fragment] = link.split('#', 2);
        const path = decodeURIComponent(location?.split('?')[0] ?? '');
        const target = !path ? source : path.startsWith('/') ? resolve(root, `.${path}`) : resolve(dirname(source), path);
        const anchor = fragment && decodeURIComponent(fragment);
        if (!(target === root || target.startsWith(root + sep)) || !existsSync(target)) {
          errors.push(`${file}: missing local target ${link}`);
        } else if (anchor && target.endsWith('.md') && statSync(target).isFile() && !documents.get(target)?.anchors.has(anchor)) {
          errors.push(`${file}: missing heading ${link}`);
        }
      } catch (error) {
        errors.push(`${file}: invalid link ${link}: ${error}`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md'], { encoding: 'utf8' })
    .split('\0').filter(file => file && existsSync(file));
  const errors = verifyMarkdown(process.cwd(), files);
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log(`Verified local links, headings and LF in ${files.length} Markdown files.`);
}
