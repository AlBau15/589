// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title Pago atómico en MXNB con reparto creador / plataforma (Arbitrum)
/// @notice El operador (tu backend) firma cada orden fuera de la cadena (EIP-712) sin gastar gas.
///         El comprador envía la orden firmada y paga en una sola transacción; el contrato
///         verifica la firma y reparte el pago entre el creador y la tesorería.
/// @dev MXNB es un token ERC-20 detrás de un proxy actualizable (6 decimales).
///      Apunta siempre al proxy, nunca a la implementación.
///      El contrato nunca retiene fondos: los pagos van directo al creador y a la tesorería.
contract PagoAtomicoMXNB is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;

    /// @notice Comisión máxima de la plataforma (30 %). Garantiza a los creadores al menos el 70 %.
    uint16 public constant COMISION_MAXIMA_BPS = 3_000;

    bytes32 public constant ORDEN_TYPEHASH = keccak256(
        "Orden(bytes16 orderId,address comprador,address creador,uint128 monto,uint16 comisionBps,uint64 expiraEn)"
    );

    /// @notice Orden de compra que firma el operador.
    struct Orden {
        bytes16 orderId;
        address comprador; // única dirección que puede pagarla
        address creador; // recibe monto − comisión
        uint128 monto; // en unidades mínimas de MXNB (6 decimales)
        uint16 comisionBps; // debe coincidir con la comisión vigente al pagar
        uint64 expiraEn; // timestamp a partir del cual ya no se puede pagar
    }

    enum Estado {
        Pendiente,
        Pagada,
        Cancelada
    }

    IERC20 public immutable mxnb;
    address public tesoreria;
    address public operador;
    uint16 public comisionBps;

    /// @notice Estado de cada orderId. Una orden firmada solo se puede pagar una vez.
    mapping(bytes16 => Estado) public estados;

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
    error ComisionCambiada();
    error MontoInvalido();
    error FirmaInvalida();
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
        EIP712("PagoAtomicoMXNB", "1")
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

    // ───────────── Comprador ─────────────

    /// @notice Paga una orden firmada por el operador. Requiere `approve` previo de `orden.monto` a este contrato.
    ///         Con smart wallets (ERC-4337) se envían approve + pagarOrden en un solo UserOperation.
    function pagarOrden(Orden calldata orden, bytes calldata firma) external nonReentrant whenNotPaused {
        if (msg.sender != orden.comprador) revert CompradorInvalido();
        if (block.timestamp >= orden.expiraEn) revert OrdenExpirada();
        if (estados[orden.orderId] != Estado.Pendiente) revert OrdenNoPagable();
        if (orden.monto == 0) revert MontoInvalido();
        if (orden.creador == address(0)) revert DireccionInvalida();
        if (orden.comisionBps != comisionBps) revert ComisionCambiada();
        _verificarFirma(orden, firma);

        // Se marca antes de mover fondos (anti-repetición)
        estados[orden.orderId] = Estado.Pagada;

        uint256 monto = orden.monto;
        uint256 montoPlataforma = (monto * orden.comisionBps) / BPS;
        uint256 montoCreador = monto - montoPlataforma;

        if (montoCreador > 0) mxnb.safeTransferFrom(msg.sender, orden.creador, montoCreador);
        if (montoPlataforma > 0) mxnb.safeTransferFrom(msg.sender, tesoreria, montoPlataforma);

        emit CompraConfirmada(orden.orderId, msg.sender, orden.creador, monto, montoCreador, montoPlataforma);
    }

    /// @notice Digest EIP-712 que firma el operador. Útil para depurar firmas desde el backend.
    function hashOrden(Orden calldata orden) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ORDEN_TYPEHASH,
                    orden.orderId,
                    orden.comprador,
                    orden.creador,
                    orden.monto,
                    orden.comisionBps,
                    orden.expiraEn
                )
            )
        );
    }

    function _verificarFirma(Orden calldata orden, bytes calldata firma) private view {
        (address firmante, ECDSA.RecoverError error_,) = ECDSA.tryRecover(hashOrden(orden), firma);
        if (error_ != ECDSA.RecoverError.NoError || firmante != operador) revert FirmaInvalida();
    }

    // ───────────── Operador ─────────────

    /// @notice Invalida una orden firmada antes de que se pague. Las órdenes también caducan solas en `expiraEn`.
    function cancelarOrden(bytes16 orderId) external soloOperador {
        if (estados[orderId] != Estado.Pendiente) revert OrdenNoPagable();
        estados[orderId] = Estado.Cancelada;
        emit OrdenCancelada(orderId);
    }

    // ───────────── Administración (owner, idealmente un multisig) ─────────────

    function setTesoreria(address nueva) external onlyOwner {
        if (nueva == address(0)) revert DireccionInvalida();
        tesoreria = nueva;
        emit TesoreriaActualizada(nueva);
    }

    /// @dev Cambiar el operador invalida todas las órdenes firmadas por el anterior que sigan sin pagar.
    function setOperador(address nuevo) external onlyOwner {
        if (nuevo == address(0)) revert DireccionInvalida();
        operador = nuevo;
        emit OperadorActualizado(nuevo);
    }

    /// @dev Las órdenes firmadas con la comisión anterior dejan de poder pagarse (ComisionCambiada).
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
