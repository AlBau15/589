import crypto from 'node:crypto';
import { Router } from 'express';
import { getAddress } from 'viem';
import * as db from './db.js';
import * as juno from './juno.js';
import { seguro } from './unidades.js';

const tagJuno = (userId) => 'u_' + crypto.createHash('sha256').update(userId).digest('hex').slice(0, 24);

export function rutasOnboarding({ privy, autenticar, limitador }) {
  const router = Router();

  router.post(
    '/api/onboarding',
    autenticar,
    limitador,
    seguro(async (req, res) => {
      const usuario = await privy.getUser(req.userId);
      const smart = usuario.linkedAccounts.find((a) => a.type === 'smart_wallet');
      if (!smart?.address) {
        return res.status(409).json({
          exito: false,
          error: 'La smart wallet aún no está lista. Activa smart wallets y el paymaster en el panel de Privy.',
        });
      }

      const { tomado, perfil } = await db.tomarOnboarding(req.userId, smart.address.toLowerCase());
      if (perfil.estado === 'completo') {
        return res.json({ exito: true, clabe: perfil.clabe, wallet: getAddress(perfil.wallet) });
      }
      if (!tomado) return res.status(202).json({ exito: true, estado: 'en_proceso' });

      try {
        let { clabe, junoTag } = perfil;
        if (!clabe) {
          junoTag = tagJuno(req.userId);
          clabe = await juno.crearClabe();
          try {
            await db.guardarClabe(req.userId, clabe, junoTag);
          } catch (error) {
            console.error(`CLABE creada pero no guardada: user=${req.userId} clabe=${clabe}`);
            throw error;
          }
        }
        if (!perfil.walletRegistrada) {
          await juno.registrarWallet({ tag: junoTag, address: getAddress(perfil.wallet) });
          await db.marcarWalletRegistrada(req.userId);
        }
        await db.completarOnboarding(req.userId);
        return res.json({ exito: true, clabe, wallet: getAddress(perfil.wallet) });
      } catch (error) {
        await db.liberarOnboarding(req.userId).catch(() => {});
        throw error;
      }
    })
  );

  return router;
}
