import fs from "fs/promises";
import path from "path";
import unified from "unified";
import markdown from "remark-parse";
import remarkToRehype from "remark-rehype";
import raw from "rehype-raw";
import visit from "unist-util-visit";
import GitHubSlugger from "github-slugger";
import matter from "gray-matter";
import { setFailed } from "./github";
import { DOCS_PATH, Document, EXCLUDED_HASHES, LinkError } from "./config";

const slugger = new GitHubSlugger();

/** Collect the paths of all .mdx files in the passed directories */
const getAllMdxFilePaths = async (
  directoriesToScan: string[],
  fileList: string[] = []
): Promise<string[]> => {
  for (const dir of directoriesToScan) {
    const dirPath = path.join(".", dir);
    const files = await fs.readdir(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        fileList = await getAllMdxFilePaths([filePath], fileList);
      } else if (path.extname(file) === ".mdx") {
        fileList.push(filePath);
      }
    }
  }

  return fileList;
};

// Returns the slugs of all headings in a tree
const getHeadingsFromMarkdownTree = (
  tree: ReturnType<typeof markdownProcessor.parse>
): string[] => {
  const headings: string[] = [];
  slugger.reset();

  visit(tree, "heading", (node) => {
    let headingText = "";
    // Account for headings with inline code blocks by concatenating the
    // text values of all children of a heading node.
    visit(node, (innerNode: any) => {
      if (innerNode.value) {
        headingText += innerNode.value;
      }
    });
    headings.push(slugger.slug(headingText));
  });

  return headings;
};

/** Create a processor to parse MDX content */
const markdownProcessor = unified()
  .use(markdown)
  .use(remarkToRehype, { allowDangerousHTML: true })
  .use(raw)
  .use(function compiler() {
    // A compiler is required, and we only need the AST, so we can
    // just return it.
    // @ts-ignore
    this.Compiler = function treeCompiler(tree) {
      return tree;
    };
  });

const normalizePath = (filePath: string): string => {
  const normalized = filePath
    .replace("repo-docs", "/repo/docs")
    .replace("pack-docs", "/pack/docs")
    .replace(".mdx", "");

  return normalized;
};

/**
 * Create a map of documents with their paths as keys and
 * document content and metadata as values
 * The key varies between doc pages and error pages
 * error pages: `/docs/messages/example`
 * doc pages: `api/example`
 */
const prepareDocumentMapEntry = async (
  filePath: string
): Promise<[string, Document]> => {
  try {
    const mdxContent = await fs.readFile(filePath, "utf8");
    const { content, data } = matter(mdxContent);
    const tree = markdownProcessor.parse(content);
    const headings = getHeadingsFromMarkdownTree(tree);
    const normalizedUrlPath = normalizePath(filePath);

    return [
      normalizedUrlPath,
      { body: content, path: filePath, headings, ...data },
    ];
  } catch (error) {
    setFailed(`Error preparing document map for file ${filePath}: ${error}`);
    return ["", {} as Document];
  }
};

/** Checks if the links point to existing documents */
const validateInternalLink =
  (documentMap: Map<string, Document>) => (doc: Document, href: string) => {
    // /docs/api/example#heading -> ["api/example", "heading""]
    const [link, hash] = href.replace(DOCS_PATH, "").split("#", 2);

    // These paths exist, just not in our Markdown files
    const ignorePaths = ["/api/remote-cache-spec", "/repo"];
    if (ignorePaths.includes(link)) {
      return [];
    }

    let foundPage = documentMap.get(link);

    if (!foundPage) {
      foundPage = documentMap.get(`${link}/index`);
    }

    let errors: LinkError[] = [];

    if (!foundPage) {
      errors.push({
        type: "link",
        href,
        doc,
      });
    } else if (hash && !EXCLUDED_HASHES.includes(hash)) {
      // Check if the hash link points to an existing section within the document
      const hashFound = foundPage.headings.includes(hash);

      if (!hashFound) {
        errors.push({
          type: "hash",
          href,
          doc,
        });
      }
    }

    return errors;
  };

/** Checks if the hash links point to existing sections within the same document */
const validateHashLink = (doc: Document, href: string) => {
  const hashLink = href.replace("#", "");

  if (!EXCLUDED_HASHES.includes(hashLink) && !doc.headings.includes(hashLink)) {
    let linkError: LinkError = {
      type: "hash",
      href,
      doc,
    };
    return [linkError];
  }
  return [];
};

// corresponds to vfile.VFile['contents']
type Tree = string | Uint8Array;

/** Traverse the document tree and validate links */
const traverseTreeAndValidateLinks = (
  documentMap: Map<string, Document>,
  tree: any, // TODO: Tree
  doc: Document
): LinkError[] => {
  let errors: LinkError[] = [];

  try {
    visit(tree, (node: any) => {
      if (node.type === "element" && node.tagName === "a") {
        const href = node.properties.href;

        if (!href) {
          return;
        }

        if (href.startsWith("/")) {
          errors.push(...validateInternalLink(documentMap)(doc, href));
        } else if (href.startsWith("#")) {
          errors.push(...validateHashLink(doc, href));
        }
      }
    });
  } catch (error) {
    setFailed("Error traversing tree: " + error);
  }

  return errors;
};

/**
 * this function will look through all Mdx files and compile a list of `LinkError`s
 */
export const collectLinkErrors = async (): Promise<LinkError[]> => {
  const allMdxFilePaths = await getAllMdxFilePaths([DOCS_PATH]);

  const documentMap = new Map(
    await Promise.all(allMdxFilePaths.map(prepareDocumentMapEntry))
  );

  const reportsWithErrors = allMdxFilePaths.map(async (filePath) => {
    const doc = documentMap.get(normalizePath(filePath));
    if (!doc) {
      return null;
    }
    const { contents: tree } = await markdownProcessor.process(doc.body);
    const linkErrors = traverseTreeAndValidateLinks(documentMap, tree, doc);
    if (linkErrors.length > 0) {
      return linkErrors;
    }
    return null;
  });

  const results = await Promise.all(reportsWithErrors);
  const linkErrors = results.filter((report) => report !== null).flat();
  return linkErrors;
};
