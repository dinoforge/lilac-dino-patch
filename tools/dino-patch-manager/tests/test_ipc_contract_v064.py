"""Regression checks for official v0.5.63 and v0.5.64 provider:detail IPC routing."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import manager_core as core


OLD_DETAIL = """
ipcMain.handle('provider:detail', (_, anime) => {
  const promise=loadProviderDetail(anime);
  return promise;
});
"""

NEW_DETAIL = """
const providerDetails=new Map();
const providerDetail = anime => {
  const key=anime.id,kept=providerDetails.get(key);
  if(kept&&Date.now()-kept.at<5*60000)return kept.promise;
  const promise=loadProviderDetail(anime);providerDetails.set(key,{at:Date.now(),promise});
  promise.catch(()=>{if(providerDetails.get(key)?.promise===promise)providerDetails.delete(key)});
  return promise;
};
ipcMain.handle('provider:detail', (_, anime) => providerDetail(anime));
"""


class ProviderDetailContractTests(unittest.TestCase):
    def test_v063_block_handler_remains_supported(self):
        params, body = core._ipc_handler_contract(OLD_DETAIL, "provider:detail")
        self.assertEqual(params, [("_", None), ("anime", None)])
        self.assertIn("loadProviderDetail(anime)", body)
        self.assertIn("return promise", body)

    def test_v064_delegate_handler_checks_real_loader(self):
        params, body = core._ipc_handler_contract(NEW_DETAIL, "provider:detail")
        self.assertEqual(params, [("_", None), ("anime", None)])
        self.assertIn("loadProviderDetail(anime)", body)
        self.assertIn("return promise", body)

    def test_duplicate_registration_blocks_instead_of_picking_first(self):
        with self.assertRaises(core.ManagerError):
            core._ipc_handler_contract(OLD_DETAIL + NEW_DETAIL, "provider:detail")

    def test_unrecognized_wrapper_blocks(self):
        bad = NEW_DETAIL.replace("=> providerDetail(anime)", "=> unknownDetail(anime)")
        with self.assertRaises(core.ManagerError):
            core._ipc_handler_contract(bad, "provider:detail")

    def test_wrapper_without_verified_loader_blocks(self):
        bad = NEW_DETAIL.replace("const promise=loadProviderDetail(anime)", "const promise=otherDetail(anime)")
        with self.assertRaises(core.ManagerError):
            core._ipc_handler_contract(bad, "provider:detail")

    def test_wrapper_with_wrong_argument_blocks(self):
        bad = NEW_DETAIL.replace("=> providerDetail(anime)", "=> providerDetail(episode)")
        with self.assertRaises(core.ManagerError):
            core._ipc_handler_contract(bad, "provider:detail")


if __name__ == "__main__":
    unittest.main()
