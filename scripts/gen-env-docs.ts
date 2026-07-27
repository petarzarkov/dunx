import fs from 'node:fs';
import path from 'node:path';
import * as glob from 'glob';

/**
 * Configuration for grouping environment variables.
 * The key is the title that will appear in the Markdown file.
 * The value can be a single affix string or an array of affixes.
 * The order of this object determines the order of sections in the output file.
 */
const groupConfig: Record<string, string | string[]> = {
  'PostgreSQL Database': 'POSTGRES_',
  RabbitMQ: 'RABBITMQ_',
  Redis: 'REDIS_',
  Email: 'EMAIL_',
  Application: ['APP_', 'API_', 'SWAGGER_', 'LOG_'],
  'Security & JWT': ['JWT_', 'USER_API_CREDENTIALS_'],
  WebSocket: 'WS_',
  'HTTP Client': 'HTTP_REQ_',
  OAuth: 'OAUTH_',
  Gemini: 'GEMINI_',
  AWS: 'AWS_',
  General: '',
};

interface ParsedVariable {
  name: string;
  value: string;
  description: string;
  source: string;
}

/**
 * Main function to generate the documentation.
 */
function generateEnvDocs(): void {
  console.log('Generating environment variable documentation...');

  const envFiles = findAllEnvSampleFiles();
  if (envFiles.length === 0) {
    console.error('Error: No .env.sample files found');
    process.exit(1);
  }

  console.log(`Found ${envFiles.length} .env.sample files:`);
  // biome-ignore lint/suspicious/useIterableCallbackReturn: nn
  envFiles.forEach((file) => console.log(`  - ${file}`));

  const allParsedVars: ParsedVariable[] = [];

  for (const filePath of envFiles) {
    const relativePath = path.relative(process.cwd(), filePath);
    const parsedVars = parseEnvFile(filePath, relativePath);
    allParsedVars.push(...parsedVars);
  }

  const groupedVars = groupVariables(allParsedVars);
  const markdownContent = generateMarkdown(groupedVars);
  writeMarkdownFile(markdownContent);

  console.log('✅ Successfully generated env-vars.md');
}

/**
 * Finds all .env.sample files.
 */
function findAllEnvSampleFiles(): string[] {
  const rootDir = process.cwd();
  const patterns = [path.join(rootDir, '.env.sample')];

  const envFiles: string[] = [];
  for (const pattern of patterns) {
    const matches = glob.sync(pattern, {
      ignore: ['**/node_modules/**'],
    });
    envFiles.push(...matches);
  }

  return envFiles.sort();
}

/**
 * Parses a single .env.sample file and returns the parsed variables.
 */
function parseEnvFile(
  filePath: string,
  relativePath: string,
): ParsedVariable[] {
  if (!fs.existsSync(filePath)) {
    console.warn(`Warning: .env.sample file not found at ${filePath}`);
    return [];
  }

  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const lines = fileContent.split('\n');
  const parsedVars: ParsedVariable[] = [];

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) {
      continue;
    }

    const match = line.match(/^([^#=]+)=([^#]*)#?(.*)$/);
    if (match) {
      const [, name, value, description] = match.map((s) => s.trim());
      parsedVars.push({
        name,
        value,
        description,
        source: relativePath,
      });
    }
  }

  return parsedVars;
}

/**
 * Groups the parsed variables based on the groupConfig affixes.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: script
function groupVariables(
  vars: ParsedVariable[],
): Record<string, ParsedVariable[]> {
  const grouped: Record<string, ParsedVariable[]> = {};
  const groupTitles = Object.keys(groupConfig);

  for (const v of vars) {
    let assigned = false;
    for (const title of groupTitles) {
      const prefixes = groupConfig[title];

      // Handle both string and array of strings
      const prefixesToCheck = Array.isArray(prefixes) ? prefixes : [prefixes];

      for (const prefix of prefixesToCheck) {
        // The catch-all group has an empty prefix, so it shouldn't match here.
        if (prefix && v.name.startsWith(prefix)) {
          if (!grouped[title]) {
            grouped[title] = [];
          }
          grouped[title].push(v);
          assigned = true;
          break;
        }
      }
      if (assigned) {
        break;
      }
    }

    if (!assigned) {
      const generalTitle =
        groupTitles.find((title) => groupConfig[title] === '') || 'General';
      if (!grouped[generalTitle]) {
        grouped[generalTitle] = [];
      }
      grouped[generalTitle].push(v);
    }
  }

  return grouped;
}

/**
 * Generates the full Markdown string from the grouped variables.
 */
function generateMarkdown(
  groupedVars: Record<string, ParsedVariable[]>,
): string {
  let markdown = '# Environment Variables\n\n';
  markdown +=
    'This document outlines the environment variables required for the project. These are defined in `.env.sample` files and should be configured in local `.env` files for development.\n\n';
  markdown +=
    '> **Note**: Make sure to create corresponding `.env` files in the same directories.\n\n';

  for (const title of Object.keys(groupConfig)) {
    const vars = groupedVars[title];
    if (!vars || vars.length === 0) {
      continue;
    }

    markdown += `### ${title}\n\n`;
    markdown += '| Variable | Description | Default Value | Source |\n';
    markdown += '|---|---|---|---|\n';

    const uniqueVars = vars.reduce(
      (acc: ParsedVariable[], current: ParsedVariable) => {
        const existing = acc.find((v) => v.name === current.name);
        if (!existing) {
          acc.push(current);
        } else {
          existing.source += `, ${current.source}`;
        }
        return acc;
      },
      [],
    );

    for (const v of uniqueVars) {
      const description = v.description || 'No description provided.';
      markdown += `| \`${v.name}\` | ${description} | \`${v.value}\` | ${v.source} |\n`;
    }
    markdown += '\n';
  }

  return markdown;
}

/**
 * Writes the generated Markdown content to a file.
 */
function writeMarkdownFile(content: string): void {
  const outputDir = path.resolve(process.cwd());
  const outputPath = path.resolve(outputDir, 'env-vars.md');

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
  }

  fs.writeFileSync(outputPath, content);
}

generateEnvDocs();
