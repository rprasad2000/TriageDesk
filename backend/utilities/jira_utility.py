# backend/utilities/jira_utility.py
from jira import JIRA
from typing import List, Dict, Any
import math

class JiraUtility:
    def __init__(self, host: str, username: str, api_token: str, timeout: int = 30):
        # keep same signature as before
        self.jira = JIRA(server=host, basic_auth=(username, api_token), timeout=timeout)

    async def get_issues(self, jql: str, max_results: int = 10000) -> List[Dict[str, Any]]:
        """
        Fetch issues from Jira using pagination. Jira's max page size is typically 100.
        Returns list of raw issue objects (dicts).
        """
        page_size = 100
        start_at = 0
        all_issues = []

        # ensure we don't attempt infinite loop
        max_results = int(max_results or 10000)
        while True:
            # jira.search_issues is synchronous — but our endpoint is async; that's okay
            block = self.jira.search_issues(
                jql,
                startAt=start_at,
                maxResults=min(page_size, max_results - start_at),
                expand="renderedFields"
            )
            if not block:
                break
            all_issues.extend([issue.raw for issue in block])
            start_at += len(block)
            if start_at >= max_results or len(block) < page_size:
                break

        return all_issues
