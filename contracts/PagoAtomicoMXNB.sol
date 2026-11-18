// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Pago atómico en MXNB con reparto creador / plataforma (Arbitrum)
/// @notice El operador (tu backend) crea órdenes con monto, comprador, creador y caducidad fijos.
///         El comprador paga una sola vez y el contrato reparte en la misma transacción.
/// @dev MXNB es un token ERC-20 detrás de un proxy actualizable (6 decimales).
///      Apunta siempre al proxy, nunca a la implementación.
///      El contrato nunca retiene fondos: los pagos van directo al creador y a la tesorería.
contract PagoAtomicoMXNB is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;

    /// @notice Comisión máxima de la plataforma (30 %). Garantiza a los creadores al menos el 70 %.
    uint16 public constant COMISION_MAXIMA_BPS = 3_000;

    IERC20 public immutable mxnb;
    address public tesoreria;
    address public operador;
    uint16 public comisionBps;

    // Empaquetado en 3 slots: comprador | creador | monto + comisionBps + pagada + cancelada + expiraEn
    struct Orden {
        address comprador;
        address creador;
        uint128 monto;
        uint16 comisionBps; // se congela al crear la orden
        bool pagada;
        bool cancelada;
        uint64 expiraEn; // timestamp a partir del cual ya no se puede pagar
    }

    mapping(bytes16 => Orden) public ordenes;

    event OrdenCreada(
        bytes16 indexed orderId,
        address indexed comprador,
        address indexed creador,
        uint128 monto,
        uint16 comisionBps,
        uint64 expiraEn
    );
    event OrdenCancelada(bytes16 indexed orderId);
    event CompraConfirmada(
        bytes16 indexed orderId,
        address indexed comprador,
        address indexed creador,
        uint256 montoTotal,
        uint256 montoCreador,
        uint256 montoPlataforma
    );
    event TesoreriaActualizada(address tesoreria);
    event OperadorActualizado(address operador);
    event ComisionActualizada(uint16 comisionBps);
    event TokensRescatados(address indexed token, address indexed destino, uint256 monto);

    error NoAutorizado();
    error DireccionInvalida();
    error ComisionInvalida();
    error MontoInvalido();
    error CaducidadInvalida();
    error OrdenExistente();
    error OrdenInexistente();
    error OrdenNoPagable();
    error OrdenExpirada();
    error CompradorInvalido();
    error RenunciaDeshabilitada();

    modifier soloOperador() {
        if (msg.sender != operador) revert NoAutorizado();
        _;
    }

    constructor(IERC20 mxnb_, address tesoreria_, address operador_, uint16 comisionBps_, address owner_)
        Ownable(owner_)
    {
        if (address(mxnb_) == address(0) || tesoreria_ == address(0) || operador_ == address(0)) {
            revert DireccionInvalida();
        }
        if (comisionBps_ > COMISION_MAXIMA_BPS) revert ComisionInvalida();
        mxnb = mxnb_;
        tesoreria = tesoreria_;
        operador = operador_;
        comisionBps = comisionBps_;
    }

    // ───────────── Operador ─────────────

    /// @param expiraEn Timestamp (segundos) hasta el que se puede pagar la orden, exclusivo.
    function crearOrden(bytes16 orderId, address comprador, address creador, uint128 monto, uint64 expiraEn)
        external
        soloOperador
        whenNotPaused
    {
        if (comprador == address(0) || creador == address(0)) revert DireccionInvalida();
        if (monto == 0) revert MontoInvalido();
        if (expiraEn <= block.timestamp) revert CaducidadInvalida();
        if (ordenes[orderId].comprador != address(0)) revert OrdenExistente();

        ordenes[orderId] = Orden({
            comprador: comprador,
            creador: creador,
            monto: monto,
            comisionBps: comisionBps,
            pagada: false,
            cancelada: false,
            expiraEn: expiraEn
        });
        emit OrdenCreada(orderId, comprador, creador, monto, comisionBps, expiraEn);
    }

    function cancelarOrden(bytes16 orderId) external soloOperador {
        Orden storage o = ordenes[orderId];
        if (o.comprador == address(0)) revert OrdenInexistente();
        if (o.pagada || o.cancelada) revert OrdenNoPagable();
        o.cancelada = true;
        emit OrdenCancelada(orderId);
    }

    // ───────────── Comprador ─────────────

    /// @notice Paga una orden. Requiere `approve` previo del monto exacto a este contrato.
    ///         Con smart wallets (ERC-4337) se envían approve + pagarOrden en un solo UserOperation.
    function pagarOrden(bytes16 orderId) external nonReentrant whenNotPaused {
        Orden storage o = ordenes[orderId];
        if (o.comprador == address(0)) revert OrdenInexistente();
        if (o.pagada || o.cancelada) revert OrdenNoPagable();
        if (block.timestamp >= o.expiraEn) revert OrdenExpirada();
        if (msg.sender != o.comprador) revert CompradorInvalido();

        // Se marca antes de mover fondos (anti-repetición)
        o.pagada = true;

        uint256 monto = o.monto;
        uint256 montoPlataforma = (monto * o.comisionBps) / BPS;
        uint256 montoCreador = monto - montoPlataforma;
        address creador = o.creador;

        if (montoCreador > 0) mxnb.safeTransferFrom(msg.sender, creador, montoCreador);
        if (montoPlataforma > 0) mxnb.safeTransferFrom(msg.sender, tesoreria, montoPlataforma);

        emit CompraConfirmada(orderId, msg.sender, creador, monto, montoCreador, montoPlataforma);
    }

    // ───────────── Administración (owner, idealmente un multisig) ─────────────

    function setTesoreria(address nueva) external onlyOwner {
        if (nueva == address(0)) revert DireccionInvalida();
        tesoreria = nueva;
        emit TesoreriaActualizada(nueva);
    }

    function setOperador(address nuevo) external onlyOwner {
        if (nuevo == address(0)) revert DireccionInvalida();
        operador = nuevo;
        emit OperadorActualizado(nuevo);
    }

    /// @dev Solo afecta a órdenes nuevas; las existentes conservan su comisión.
    function setComisionBps(uint16 nueva) external onlyOwner {
        if (nueva > COMISION_MAXIMA_BPS) revert ComisionInvalida();
        comisionBps = nueva;
        emit ComisionActualizada(nueva);
    }

    function pausar() external onlyOwner {
        _pause();
    }

    function reanudar() external onlyOwner {
        _unpause();
    }

    /// @notice Recupera tokens enviados por error directamente al contrato.
    /// @dev El contrato nunca retiene fondos de órdenes, así que cualquier saldo es un envío accidental.
    function rescatarTokens(IERC20 token, address destino, uint256 monto) external onlyOwner {
        if (destino == address(0)) revert DireccionInvalida();
        token.safeTransfer(destino, monto);
        emit TokensRescatados(address(token), destino, monto);
    }

    /// @notice Deshabilitado: sin owner nadie podría pausar el contrato ni cambiar tesorería u operador.
    ///         Para cambiar de administrador usa transferOwnership + acceptOwnership.
    function renounceOwnership() public view override onlyOwner {
        revert RenunciaDeshabilitada();
    }
}
