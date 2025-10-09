# backend/utilities/jira_utility.py
import asyncio
import logging
from typing import List, Dict, Any, Optional, Union
import logging
import httpx
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)



logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


class JiraUtility:
    """
    Minimal async Jira helper that returns a list of issue dicts (the 'issues' array)
    fetched from the Jira Cloud search endpoint. Uses BasicAuth with provided
    username and API token and handles cursor pagination (nextPageToken).
    """

    def __init__(self, host: str, username: str, api_token: str, timeout: float = 30.0):
        self.host = host.rstrip("/")
        self.username = username
        self.api_token = api_token
        self.timeout = timeout
        # httpx accepts tuple (user, pass) for auth or httpx.BasicAuth
        self._auth = httpx.BasicAuth(self.username, self.api_token)

        # canonical endpoints
        # Note: your instance accepts /rest/api/3/search/jql — we support that path,
        # but default to the standard search URL too.
        self._search_jql_url = f"{self.host}/rest/api/3/search/jql"
        self._search_url = f"{self.host}/rest/api/3/search"
        self._issue_base = f"{self.host}/rest/api/3/issue"

    async def get_issues(
        self,
        jql: str,
        max_results: int = 10000,
        fields: Optional[Union[List[str], str]] = None,
        page_size: int = 100,
    ) -> List[Dict[str, Any]]:
        """
        Fetch issues for a JQL using cursor pagination (nextPageToken) or the standard
        search endpoint. Returns a list of issue dicts (same shape as Jira 'issues' array).
        - `fields`: None => '*all' (full objects). Passing a list or comma-string works.
        - `max_results`: maximum number of issues to return.
        """
        if fields is None:
            fields_param = "*all"
        else:
            if isinstance(fields, list):
                # Join, but preserve "*all" if explicitly requested
                if len(fields) == 1 and fields[0] == "*all":
                    fields_param = "*all"
                else:
                    fields_param = ",".join(fields)
            else:
                fields_param = fields

        collected: List[Dict[str, Any]] = []
        max_results = int(max_results or 0) or 10000
        page_token: Optional[str] = None
        page_size = int(page_size) if page_size and page_size > 0 else 100

        # try the search/jql endpoint first (some tenants prefer this)
        search_url_candidates = [self._search_jql_url, self._search_url]

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            for search_url in search_url_candidates:
                try:
                    collected = []
                    page_token = None
                    while len(collected) < max_results:
                        params = {
                            "jql": jql,
                            "fields": fields_param,
                            "maxResults": min(page_size, max_results - len(collected)),
                        }
                        if page_token:
                            params["nextPageToken"] = page_token

                        try:
                            resp = await client.get(search_url, params=params, auth=self._auth)
                            resp.raise_for_status()
                        except httpx.HTTPStatusError as he:
                            # Some tenants require POST for cursor / nextPageToken usage
                            status = he.response.status_code if he.response is not None else None
                            if status in (400, 405):
                                payload = {
                                    "jql": jql,
                                    "fields": fields_param if isinstance(fields_param, str) else fields_param,
                                    "maxResults": min(page_size, max_results - len(collected)),
                                }
                                if page_token:
                                    payload["nextPageToken"] = page_token
                                resp = await client.post(search_url, json=payload, auth=self._auth)
                                resp.raise_for_status()
                            else:
                                # re-raise so outer except picks it up
                                raise

                        data = resp.json()
                        # Accept either top-level 'issues' or 'values' (some endpoints vary)
                        if isinstance(data, dict):
                            issues = data.get("issues") or data.get("values") or []
                        elif isinstance(data, list):
                            # some endpoints may return a list directly (rare)
                            issues = data
                        else:
                            issues = []

                        # If the endpoint returned nothing and indicated last page, break
                        if not issues and (isinstance(data, dict) and data.get("isLast", True)):
                            break

                        # extend and handle pagination
                        collected.extend(issues)
                        # nextPageToken may be present for cursor pagination
                        page_token = (data.get("nextPageToken") if isinstance(data, dict) else None)
                        if not page_token or (isinstance(data, dict) and data.get("isLast", False)):
                            break

                        # polite short sleep to avoid hammering Jira
                        await asyncio.sleep(0.05)

                    # If we fetched any issues from this URL, consider success and break
                    if collected:
                        break
                except Exception as e:
                    # try the next candidate URL; log the exception
                    logger.info("JiraUtility: attempt with url %s failed: %s", search_url, str(e))
                    continue

        # ensure deterministic truncation to max_results
        result = collected[:max_results]
        logger.info("JiraUtility.get_issues: fetched %d issues (requested %d)", len(result), max_results)
        return result

    # small helpers for comments/labels/issue fetch

    async def get_issue(self, issue_key: str, fields: Optional[Union[str, List[str]]] = "*all") -> Dict[str, Any]:
        url = f"{self._issue_base}/{httpx.utils.quote(issue_key, safe='')}"
        params = {"fields": fields} if fields is not None else None
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.get(url, params=params, auth=self._auth)
            resp.raise_for_status()
            return resp.json()

    async def post_comment(self, issue_key: str, comment: str) -> Dict[str, Any]:
        if not issue_key or comment is None:
            raise ValueError("issue_key and comment required")
        url = f"{self._issue_base}/{httpx.utils.quote(issue_key, safe='')}/comment"
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(url, json={"body": comment}, auth=self._auth)
            resp.raise_for_status()
            return resp.json()

    async def update_issue_fields(self, issue_key: str, fields: Dict[str, Any]) -> Dict[str, Any]:
        if not issue_key:
            raise ValueError("issue_key required")
        url = f"{self._issue_base}/{httpx.utils.quote(issue_key, safe='')}"
        payload = {"fields": fields}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.put(url, json=payload, auth=self._auth)
            resp.raise_for_status()
            return resp.json()

    async def add_label(self, issue_key: str, label: str, mode: str = "add") -> List[str]:
        """
        Add/replace labels, returning the final labels list.
        """
        if not issue_key or not label:
            raise ValueError("issue_key and label required")
        # fetch issue, current labels
        issue = await self.get_issue(issue_key, fields="labels")
        current = (issue.get("fields") or {}).get("labels", []) or []
        sanitized = str(label).strip().replace(" ", "_")
        if mode == "replace":
            new_labels = [sanitized]
        else:
            if sanitized in current:
                new_labels = current
            else:
                new_labels = current + [sanitized]
        await self.update_issue_fields(issue_key, {"labels": new_labels})
        return new_labels
