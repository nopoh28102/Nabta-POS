import importlib.util
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'dnshe_auto_renew.py'
spec = importlib.util.spec_from_file_location('dnshe_auto_renew', SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
NOW = datetime(2026, 10, 30, tzinfo=timezone.utc)


class DomainRenewTests(unittest.TestCase):
    def test_eligible_within_window(self):
        domain = {'status': 'active', 'expires_at': (NOW + timedelta(days=90)).isoformat(), 'never_expires': 0}
        self.assertTrue(mod.eligibility(domain, NOW)[0])

    def test_no_renew_outside_window(self):
        domain = {'status': 'active', 'expires_at': (NOW + timedelta(days=175)).isoformat()}
        self.assertFalse(mod.eligibility(domain, NOW)[0])

    def test_refuse_expired_domain(self):
        with self.assertRaises(mod.DnsheError):
            mod.eligibility({'status': 'active', 'expires_at': (NOW - timedelta(days=2)).isoformat()}, NOW)

    def test_skip_permanent_even_without_expiry(self):
        self.assertFalse(mod.eligibility({'never_expires': '1'}, NOW)[0])

    def test_matching_exact_domain_only(self):
        mock_result = {'success': True, 'subdomains': [
            {'id': 2, 'full_domain': 'nabta-else.de5.net'},
            {'id': 3, 'subdomain': 'nabta', 'rootdomain': 'de5.net'},
        ]}
        with patch.object(mod, 'api_call', return_value=mock_result):
            self.assertEqual(mod.find_exact_domain('k', 's', 'nabta.de5.net')['id'], 3)

    def test_check_mode_does_not_write(self):
        future = (datetime.now(timezone.utc) + timedelta(days=100)).strftime('%Y-%m-%d %H:%M:%S')
        responses = [
            {'success': True, 'subdomains': [{'id': 7, 'full_domain': 'nabta.de5.net'}]},
            {'success': True, 'subdomain': {'id': 7, 'full_domain': 'nabta.de5.net', 'status': 'active', 'expires_at': future}}
        ]
        with patch.object(mod, 'api_call', side_effect=responses) as mocked:
            mod.run('check', 'nabta.de5.net', 'key', 'secret')
        self.assertEqual(mocked.call_count, 2)
        self.assertFalse(any(call.kwargs.get('method') == 'POST' for call in mocked.call_args_list))

    def test_renew_mode_targets_one_and_validates_free(self):
        now = datetime.now(timezone.utc)
        old = (now + timedelta(days=100)).strftime('%Y-%m-%d %H:%M:%S')
        new = (now + timedelta(days=465)).strftime('%Y-%m-%d %H:%M:%S')
        responses = [
            {'success': True, 'subdomains': [{'id': 7, 'full_domain': 'nabta.de5.net'}]},
            {'success': True, 'subdomain': {'id': 7, 'full_domain': 'nabta.de5.net', 'status': 'active', 'expires_at': old}},
            {'success': True, 'subdomain_id': 7, 'charged_amount': 0, 'new_expires_at': new},
        ]
        with patch.object(mod, 'api_call', side_effect=responses) as mocked:
            mod.run('renew', 'nabta.de5.net', 'key', 'secret')
        self.assertEqual(mocked.call_args_list[2].kwargs['params'], {'subdomain_id': 7})
        self.assertEqual(mocked.call_args_list[2].kwargs['method'], 'POST')

if __name__ == '__main__':
    unittest.main()
