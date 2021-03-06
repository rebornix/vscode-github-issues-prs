import * as path from 'path';

import * as GitHub from 'github';
import { copy } from 'copy-paste';
import { fill } from 'git-credential-node';

import { EventEmitter, TreeDataProvider, TreeItem, ExtensionContext, Uri, TreeItemCollapsibleState, window, workspace, commands } from 'vscode';

import { exec, allMatches, compareDateStrings } from './utils';

interface GitRemote {
	url: string;
	owner: string;
	repo: string;
	username: string;
}

class Milestone extends TreeItem {

	public issues: Issue[] = [];

	constructor(label: string) {
		super(label, TreeItemCollapsibleState.Expanded);
	}
}

class Issue extends TreeItem {
	constructor(label: string, public item: any) {
		super(label);
	}
}

export class GitHubIssuesPrsProvider implements TreeDataProvider<TreeItem> {

	private _onDidChangeTreeData = new EventEmitter<TreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private github = new GitHub();

	private fetching = false;
	private lastFetch: number;
	private children: Promise<TreeItem[]> | undefined;

	constructor(private context: ExtensionContext) {
		context.subscriptions.push(commands.registerCommand('githubIssuesPrs.refresh', this.refresh, this));
		context.subscriptions.push(commands.registerCommand('githubIssuesPrs.openIssue', this.openIssue, this));
		context.subscriptions.push(commands.registerCommand('githubIssuesPrs.openPullRequest', this.openIssue, this));
		// context.subscriptions.push(commands.registerCommand('githubIssuesPrs.checkoutPullRequest', this.checkoutPullRequest, this));
		context.subscriptions.push(commands.registerCommand('githubIssuesPrs.copyNumber', this.copyNumber, this));
		context.subscriptions.push(commands.registerCommand('githubIssuesPrs.copyText', this.copyText, this));
		context.subscriptions.push(commands.registerCommand('githubIssuesPrs.copyMarkdown', this.copyMarkdown, this));

		context.subscriptions.push(window.onDidChangeActiveTextEditor(this.poll, this));
	}

	getTreeItem(element: TreeItem): TreeItem {
		return element;
	}

	async getChildren(element?: TreeItem): Promise<TreeItem[]> {
		if (element instanceof Milestone) {
			return element.issues;
		}

		if (!this.children) {
			this.fetching = true;
			this.lastFetch = Date.now();
			this.children = this.fetchChildren();
			this.children.then(() => this.fetching = false);
		}

		return this.children;
	}

	private async refresh() {
		if (!this.fetching) {
			this.children = undefined;
			await this.getChildren();
			this._onDidChangeTreeData.fire();
		}
	}

	private async poll() {
		if (!this.lastFetch || this.lastFetch + 30 * 60 * 1000 < Date.now()) {
			return this.refresh();
		}
	}

	private async fetchChildren(element?: TreeItem): Promise<TreeItem[]> {
		if (!workspace.rootPath) {
			return [new TreeItem('No folder opened')];
		}

		let remotes: GitRemote[];
		try {
			remotes = await this.getGitHubRemotes();
		} catch (err) {
			return [new TreeItem('Not a GitHub repository')];
		}
		if (!remotes.length) {
			return [new TreeItem('No GitHub remotes found')];
		}

		const issues: Issue[] = [];
		const errors: TreeItem[] = [];
		for (const remote of remotes) {
			try {
				const milestones: (string | undefined)[] = await this.getCurrentMilestones(remote);
				if (!milestones.length) {
					milestones.push(undefined);
				}

				for (const milestone of milestones) {
					let q = `repo:${remote.owner}/${remote.repo} is:open`;
					if (remote.username) {
						q += ` assignee:${remote.username}`;
					}
					if (milestone) {
						q += ` milestone:"${milestone}"`;
					}

					const params = { q, sort: 'created', order: 'asc', per_page: 100 };
					const res = await this.github.search.issues(<any>params);
					issues.push(...res.data.items.map((item: any) => {
						const issue = new Issue(`${item.title} (#${item.number})`, item);
						const icon = item.pull_request ? 'git-pull-request.svg' : 'bug.svg';
						issue.iconPath = {
							light: this.context.asAbsolutePath(path.join('thirdparty', 'octicons', 'light', icon)),
							dark: this.context.asAbsolutePath(path.join('thirdparty', 'octicons', 'dark', icon))
						};
						issue.contextValue = item.pull_request ? 'pull_request' : 'issue';
						return issue;
					}));
				}
			} catch (err) {
				if (err.code === 404) {
					errors.push(new TreeItem(`Cannot access ${remote.owner}/${remote.repo}`));
				} else {
					throw err;
				}
			}
		}
		if (!issues.length) {
			return errors.length ? errors : [new TreeItem('No issues found')];
		}

		const milestoneIndex: { [title: string]: Milestone; } = {};
		const milestones: Milestone[] = [];
		for (const issue of issues) {
			const m = issue.item.milestone;
			const milestoneLabel = m && m.title || 'No Milestone';
			let milestone = milestoneIndex[milestoneLabel];
			if (!milestone) {
				milestone = new Milestone(milestoneLabel);
				milestoneIndex[milestoneLabel] = milestone;
				milestones.push(milestone);
			}
			milestone.issues.push(issue);
		}

		if (milestones.length === 1 && milestones[0].label === 'No Milestone') {
			return milestones[0].issues;
		}

		return milestones;
	}

	private openIssue(issue: Issue) {
		commands.executeCommand('vscode.open', Uri.parse(issue.item.html_url));
	}

	/* private */ async checkoutPullRequest(issue: Issue) {
		const p = Uri.parse(issue.item.repository_url).path;
		const repo = path.basename(p);
		const owner = path.basename(path.dirname(p));
		const pr = await this.github.pullRequests.get({ owner, repo, number: issue.item.number });
		const login = pr.data.head.repo.owner.login;
		const clone_url = pr.data.head.repo.clone_url;
		const remoteBranch = pr.data.head.ref;
		const localBranch = `${login}/${remoteBranch}`;
		try {
			let remote: string | undefined = undefined;
			const remotes = await exec(`git remote -v`, { cwd: workspace.rootPath });
			let m: RegExpExecArray | null;
			const r = /^([^\s]+)\s+([^\s]+)\s+\(fetch\)/gm;
			while (m = r.exec(remotes.stdout)) {
				if (m[2] === clone_url) {
					remote = m[1];
					break;
				}
			}
			if (!remote) {
				await exec(`git remote add ${login} ${clone_url}`, { cwd: workspace.rootPath });
				remote = login;
			}
			try {
				await exec(`git fetch ${remote} ${remoteBranch}`, { cwd: workspace.rootPath });
			} catch (err) {
				console.error(err);
				// git fetch prints to stderr, continue
			}
			await exec(`git checkout -b ${localBranch} ${remote}/${remoteBranch}`, { cwd: workspace.rootPath });
		} catch (err) {
			console.error(err);
			// git checkout prints to stderr, continue
		}
	}

	private copyNumber(issue: Issue) {
		copy(`#${issue.item.number}`);
	}

	private copyText(issue: Issue) {
		copy(issue.label);
	}

	private copyMarkdown(issue: Issue) {
		copy(`[#${issue.item.number}](${issue.item.html_url})`);
	}

	private async getCurrentMilestones({ owner, repo }: GitRemote): Promise<string[]> {
		const res = await this.github.issues.getMilestones({ owner, repo, per_page: 10 })
		let milestones: any[] = res.data;
		milestones.sort((a, b) => {
			const cmp = compareDateStrings(a.due_on, b.due_on);
			if (cmp) {
				return cmp;
			}
			return a.title.localeCompare(b.title);
		});
		if (milestones.length && milestones[0].due_on) {
			milestones = milestones.filter(milestone => milestone.due_on);
		}
		return milestones.slice(0, 2)
			.map(milestone => milestone.title);
	}

	private async getGitHubRemotes() {
		const { stdout } = await exec('git remote -v', { cwd: workspace.rootPath });
		const remotes: GitRemote[] = [];
		for (const url of new Set(allMatches(/^[^\s]+\s+([^\s]+)/gm, stdout, 1))) {
			const m = /([^\s]*github\.com\/([^/]+)\/([^ \.]+)[^\s]*)/.exec(url);
			if (m) {
				const url = m[1];
				const data = await fill(url);
				if (data) {
					remotes.push({ url, owner: m[2], repo: m[3], username: data.username });
				}
			}
		}
		return remotes;
	}
}
