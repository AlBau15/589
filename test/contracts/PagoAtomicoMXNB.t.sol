// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {PagoAtomicoMXNB} from "../../contracts/PagoAtomicoMXNB.sol";
import {MXNBMock} from "./mocks/MXNBMock.sol";

contract PagoAtomicoMXNBTest is Test {
    MXNBMock internal mxnb;
    PagoAtomicoMXNB internal pago;

    address internal owner = makeAddr("owner");
    address internal operador;
    uint256 internal operadorPk;
    address internal tesoreria = makeAddr("tesoreria");
    address internal comprador = makeAddr("comprador");
    address internal creador = makeAddr("creador");
    address internal atacante;
    uint256 internal atacantePk;

    uint16 internal constant COMISION = 500; // 5 %
    uint128 internal constant MONTO = 1_000_000_000; // 1,000 MXNB
    uint64 internal constant VIGENCIA = 15 minutes;
    bytes16 internal constant ORDEN = bytes16(keccak256("orden-1"));

    function setUp() public {
        vm.warp(1_700_000_000);
        (operador, operadorPk) = makeAddrAndKey("operador");
        (atacante, atacantePk) = makeAddrAndKey("atacante");
        mxnb = new MXNBMock();
        pago = new PagoAtomicoMXNB(IERC20(address(mxnb)), tesoreria, operador, COMISION, owner);
        mxnb.mint(comprador, 10_000_000_000); // 10,000 MXNB
    }

    // ───────────── Ayudas ─────────────

    function _orden(bytes16 id, uint128 monto) internal view returns (PagoAtomicoMXNB.Orden memory) {
        return PagoAtomicoMXNB.Orden({
            orderId: id,
            comprador: comprador,
            creador: creador,
            monto: monto,
            comisionBps: pago.comisionBps(),
            expiraEn: uint64(block.timestamp) + VIGENCIA
        });
    }

    function _firmar(uint256 pk, PagoAtomicoMXNB.Orden memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, pago.hashOrden(o));
        return abi.encodePacked(r, s, v);
    }

    function _pagar(PagoAtomicoMXNB.Orden memory o, bytes memory firma) internal {
        vm.startPrank(o.comprador);
        mxnb.approve(address(pago), o.monto);
        pago.pagarOrden(o, firma);
        vm.stopPrank();
    }

    function _esperarRevert(PagoAtomicoMXNB.Orden memory o, bytes memory firma, bytes4 error_) internal {
        vm.startPrank(o.comprador);
        mxnb.approve(address(pago), o.monto);
        vm.expectRevert(error_);
        pago.pagarOrden(o, firma);
        vm.stopPrank();
    }

    // ───────────── Constructor ─────────────

    function test_Constructor_GuardaParametros() public view {
        assertEq(address(pago.mxnb()), address(mxnb));
        assertEq(pago.tesoreria(), tesoreria);
        assertEq(pago.operador(), operador);
        assertEq(pago.comisionBps(), COMISION);
        assertEq(pago.owner(), owner);
    }

    function test_Constructor_RevierteConDireccionCero() public {
        vm.expectRevert(PagoAtomicoMXNB.DireccionInvalida.selector);
        new PagoAtomicoMXNB(IERC20(address(0)), tesoreria, operador, COMISION, owner);

        vm.expectRevert(PagoAtomicoMXNB.DireccionInvalida.selector);
        new PagoAtomicoMXNB(IERC20(address(mxnb)), address(0), operador, COMISION, owner);

        vm.expectRevert(PagoAtomicoMXNB.DireccionInvalida.selector);
        new PagoAtomicoMXNB(IERC20(address(mxnb)), tesoreria, address(0), COMISION, owner);
    }

    function test_Constructor_RevierteConComisionSobreElMaximo() public {
        uint16 maximo = pago.COMISION_MAXIMA_BPS();
        vm.expectRevert(PagoAtomicoMXNB.ComisionInvalida.selector);
        new PagoAtomicoMXNB(IERC20(address(mxnb)), tesoreria, operador, maximo + 1, owner);
    }

    // ───────────── EIP-712 ─────────────

    /// El digest se calcula aquí a mano, sin usar el contrato, según la especificación EIP-712.
    function test_HashOrden_SigueLaEspecificacionEIP712() public view {
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        bytes32 dominio = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("PagoAtomicoMXNB"),
                keccak256("1"),
                block.chainid,
                address(pago)
            )
        );
        bytes32 estructura = keccak256(
            abi.encode(
                keccak256(
                    "Orden(bytes16 orderId,address comprador,address creador,uint128 monto,uint16 comisionBps,uint64 expiraEn)"
                ),
                o.orderId,
                o.comprador,
                o.creador,
                o.monto,
                o.comisionBps,
                o.expiraEn
            )
        );
        assertEq(pago.hashOrden(o), keccak256(abi.encodePacked("\x19\x01", dominio, estructura)));
    }

    /// Vector generado con src/firmas.js (ver test/backend/firmas.test.js): demuestra que el contrato
    /// acepta exactamente la firma que produce el backend.
    function test_VectorFirmaBackend() public {
        // Clave pública de pruebas (anvil #0). NUNCA usarla en producción.
        address operadorVector = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
        address contratoVector = address(0xC0FFEE01);
        address compradorVector = address(0xaaaa);
        address creadorVector = address(0xbbbb);

        vm.chainId(42161);
        deployCodeTo(
            "PagoAtomicoMXNB.sol:PagoAtomicoMXNB",
            abi.encode(IERC20(address(mxnb)), tesoreria, operadorVector, uint16(500), owner),
            contratoVector
        );
        PagoAtomicoMXNB contrato = PagoAtomicoMXNB(contratoVector);

        PagoAtomicoMXNB.Orden memory o = PagoAtomicoMXNB.Orden({
            orderId: 0x000102030405060708090a0b0c0d0e0f,
            comprador: compradorVector,
            creador: creadorVector,
            monto: 1_000_000_000,
            comisionBps: 500,
            expiraEn: 2_000_000_000
        });
        bytes memory firma =
            hex"617f747b01144290ee99c8b636a4b9781be59e72b1492d7d1449d587656ec05c0bd2e32802e241e8cfc3d88b806456b0b9f4bb954ee0b70c8f656916991adbe41b";

        assertEq(contrato.hashOrden(o), 0x1e198ee1b2200e43b5382e95dea448732eeaf78d7a9f9b180b1f756007d71464);

        mxnb.mint(compradorVector, o.monto);
        vm.startPrank(compradorVector);
        mxnb.approve(contratoVector, o.monto);
        contrato.pagarOrden(o, firma);
        vm.stopPrank();

        assertEq(mxnb.balanceOf(creadorVector), 950_000_000);
        assertEq(uint8(contrato.estados(o.orderId)), uint8(PagoAtomicoMXNB.Estado.Pagada));
    }

    // ───────────── pagarOrden ─────────────

    function test_PagarOrden_RepartePagoYEmite() public {
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        bytes memory firma = _firmar(operadorPk, o);
        uint256 plataforma = (uint256(MONTO) * COMISION) / 10_000; // 50 MXNB
        uint256 parteCreador = MONTO - plataforma; // 950 MXNB
        uint256 saldoInicial = mxnb.balanceOf(comprador);

        vm.prank(comprador);
        mxnb.approve(address(pago), MONTO);

        vm.expectEmit(true, true, true, true, address(pago));
        emit PagoAtomicoMXNB.CompraConfirmada(ORDEN, comprador, creador, MONTO, parteCreador, plataforma);
        vm.prank(comprador);
        pago.pagarOrden(o, firma);

        assertEq(mxnb.balanceOf(creador), parteCreador);
        assertEq(mxnb.balanceOf(tesoreria), plataforma);
        assertEq(mxnb.balanceOf(comprador), saldoInicial - MONTO);
        assertEq(mxnb.balanceOf(address(pago)), 0);
        assertEq(mxnb.allowance(comprador, address(pago)), 0);
        assertEq(uint8(pago.estados(ORDEN)), uint8(PagoAtomicoMXNB.Estado.Pagada));
    }

    function test_PagarOrden_SinComisionTodoAlCreador() public {
        vm.prank(owner);
        pago.setComisionBps(0);
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        _pagar(o, _firmar(operadorPk, o));
        assertEq(mxnb.balanceOf(creador), MONTO);
        assertEq(mxnb.balanceOf(tesoreria), 0);
    }

    function test_PagarOrden_RevierteConFirmaDeOtraClave() public {
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        _esperarRevert(o, _firmar(atacantePk, o), PagoAtomicoMXNB.FirmaInvalida.selector);
    }

    function test_PagarOrden_RevierteSiSeAlteraLaOrden() public {
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        bytes memory firma = _firmar(operadorPk, o);

        PagoAtomicoMXNB.Orden memory alterada = o;
        alterada.monto = 1; // el comprador intenta pagar menos
        _esperarRevert(alterada, firma, PagoAtomicoMXNB.FirmaInvalida.selector);

        alterada = _orden(ORDEN, MONTO);
        alterada.creador = atacante; // alguien intenta desviar el pago
        _esperarRevert(alterada, firma, PagoAtomicoMXNB.FirmaInvalida.selector);

        alterada = _orden(ORDEN, MONTO);
        alterada.expiraEn += 1 days; // alguien intenta alargar la vigencia
        _esperarRevert(alterada, firma, PagoAtomicoMXNB.FirmaInvalida.selector);
    }

    function test_PagarOrden_RevierteConFirmaMalFormada() public {
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        _esperarRevert(o, hex"1234", PagoAtomicoMXNB.FirmaInvalida.selector);
        _esperarRevert(o, new bytes(65), PagoAtomicoMXNB.FirmaInvalida.selector);
    }

    function test_PagarOrden_FirmaDelOperadorAnteriorDejaDeValer() public {
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        bytes memory firma = _firmar(operadorPk, o);
        vm.prank(owner);
        pago.setOperador(makeAddr("nuevoOperador"));
        _esperarRevert(o, firma, PagoAtomicoMXNB.FirmaInvalida.selector);
    }

    function test_PagarOrden_FirmaDeOtroContratoNoVale() public {
        PagoAtomicoMXNB otro = new PagoAtomicoMXNB(IERC20(address(mxnb)), tesoreria, operador, COMISION, owner);
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(operadorPk, otro.hashOrden(o));
        _esperarRevert(o, abi.encodePacked(r, s, v), PagoAtomicoMXNB.FirmaInvalida.selector);
    }

    function test_PagarOrden_SoloElComprador() public {
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        bytes memory firma = _firmar(operadorPk, o);
        mxnb.mint(atacante, MONTO);
        vm.startPrank(atacante);
        mxnb.approve(address(pago), MONTO);
        vm.expectRevert(PagoAtomicoMXNB.CompradorInvalido.selector);
        pago.pagarOrden(o, firma);
        vm.stopPrank();
    }

    function test_PagarOrden_NoSePuedePagarDosVeces() public {
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        bytes memory firma = _firmar(operadorPk, o);
        _pagar(o, firma);
        _esperarRevert(o, firma, PagoAtomicoMXNB.OrdenNoPagable.selector);
    }

    function test_PagarOrden_RevierteSiEstaCancelada() public {
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        bytes memory firma = _firmar(operadorPk, o);
        vm.prank(operador);
        pago.cancelarOrden(ORDEN);
        _esperarRevert(o, firma, PagoAtomicoMXNB.OrdenNoPagable.selector);
    }

    function test_PagarOrden_FuncionaJustoAntesDeCaducar() public {
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        bytes memory firma = _firmar(operadorPk, o);
        vm.warp(o.expiraEn - 1);
        _pagar(o, firma);
        assertEq(uint8(pago.estados(ORDEN)), uint8(PagoAtomicoMXNB.Estado.Pagada));
    }

    function test_PagarOrden_RevierteAlCaducar() public {
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        bytes memory firma = _firmar(operadorPk, o);
        vm.warp(o.expiraEn);
        _esperarRevert(o, firma, PagoAtomicoMXNB.OrdenExpirada.selector);
    }

    function test_PagarOrden_RevierteSiCambioLaComision() public {
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        bytes memory firma = _firmar(operadorPk, o);
        vm.prank(owner);
        pago.setComisionBps(2_000);
        _esperarRevert(o, firma, PagoAtomicoMXNB.ComisionCambiada.selector);
    }

    function test_PagarOrden_RevierteConMontoCero() public {
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, 0);
        _esperarRevert(o, _firmar(operadorPk, o), PagoAtomicoMXNB.MontoInvalido.selector);
    }

    function test_PagarOrden_RevierteConCreadorCero() public {
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        o.creador = address(0);
        _esperarRevert(o, _firmar(operadorPk, o), PagoAtomicoMXNB.DireccionInvalida.selector);
    }

    function test_PagarOrden_RevierteEnPausa() public {
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        bytes memory firma = _firmar(operadorPk, o);
        vm.prank(owner);
        pago.pausar();
        _esperarRevert(o, firma, Pausable.EnforcedPause.selector);
    }

    function test_PagarOrden_RevierteSinAllowanceSuficiente() public {
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        bytes memory firma = _firmar(operadorPk, o);
        uint256 parteCreador = MONTO - (uint256(MONTO) * COMISION) / 10_000;
        vm.startPrank(comprador);
        mxnb.approve(address(pago), MONTO - 1);
        // El primer traspaso (al creador) cabe; el segundo (a tesorería) se queda corto por 1.
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector,
                address(pago),
                MONTO - 1 - parteCreador,
                MONTO - parteCreador
            )
        );
        pago.pagarOrden(o, firma);
        vm.stopPrank();

        // La reversión deshace todo: la orden sigue pendiente y no se movió dinero.
        assertEq(uint8(pago.estados(ORDEN)), uint8(PagoAtomicoMXNB.Estado.Pendiente));
        assertEq(mxnb.balanceOf(creador), 0);
    }

    function testFuzz_PagarOrden_RepartoCuadra(uint128 monto, uint16 bps) public {
        monto = uint128(bound(monto, 1, type(uint128).max));
        bps = uint16(bound(bps, 0, pago.COMISION_MAXIMA_BPS()));

        vm.prank(owner);
        pago.setComisionBps(bps);
        mxnb.mint(comprador, monto);
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, monto);
        _pagar(o, _firmar(operadorPk, o));

        uint256 plataforma = (uint256(monto) * bps) / 10_000;
        assertEq(mxnb.balanceOf(tesoreria), plataforma);
        assertEq(mxnb.balanceOf(creador), monto - plataforma);
        assertEq(mxnb.balanceOf(creador) + mxnb.balanceOf(tesoreria), monto);
        assertEq(mxnb.balanceOf(address(pago)), 0);
    }

    // ───────────── cancelarOrden ─────────────

    function test_CancelarOrden_MarcaYEmite() public {
        vm.expectEmit(true, false, false, false, address(pago));
        emit PagoAtomicoMXNB.OrdenCancelada(ORDEN);
        vm.prank(operador);
        pago.cancelarOrden(ORDEN);
        assertEq(uint8(pago.estados(ORDEN)), uint8(PagoAtomicoMXNB.Estado.Cancelada));
    }

    function test_CancelarOrden_SoloOperador() public {
        vm.prank(atacante);
        vm.expectRevert(PagoAtomicoMXNB.NoAutorizado.selector);
        pago.cancelarOrden(ORDEN);
    }

    function test_CancelarOrden_RevierteSiYaEstaCancelada() public {
        vm.startPrank(operador);
        pago.cancelarOrden(ORDEN);
        vm.expectRevert(PagoAtomicoMXNB.OrdenNoPagable.selector);
        pago.cancelarOrden(ORDEN);
        vm.stopPrank();
    }

    function test_CancelarOrden_RevierteSiYaEstaPagada() public {
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        _pagar(o, _firmar(operadorPk, o));
        vm.prank(operador);
        vm.expectRevert(PagoAtomicoMXNB.OrdenNoPagable.selector);
        pago.cancelarOrden(ORDEN);
    }

    // ───────────── Administración ─────────────

    function test_Admin_SoloOwner() public {
        bytes memory error_ = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, atacante);
        vm.startPrank(atacante);
        vm.expectRevert(error_);
        pago.setTesoreria(atacante);
        vm.expectRevert(error_);
        pago.setOperador(atacante);
        vm.expectRevert(error_);
        pago.setComisionBps(0);
        vm.expectRevert(error_);
        pago.pausar();
        vm.expectRevert(error_);
        pago.reanudar();
        vm.expectRevert(error_);
        pago.rescatarTokens(IERC20(address(mxnb)), atacante, 1);
        vm.expectRevert(error_);
        pago.renounceOwnership();
        vm.stopPrank();
    }

    function test_Admin_ActualizaParametros() public {
        address nuevaTesoreria = makeAddr("nuevaTesoreria");
        address nuevoOperador = makeAddr("nuevoOperador");
        uint16 maximo = pago.COMISION_MAXIMA_BPS();
        vm.startPrank(owner);
        pago.setTesoreria(nuevaTesoreria);
        pago.setOperador(nuevoOperador);
        pago.setComisionBps(maximo);
        vm.stopPrank();
        assertEq(pago.tesoreria(), nuevaTesoreria);
        assertEq(pago.operador(), nuevoOperador);
        assertEq(pago.comisionBps(), maximo);
    }

    function test_Admin_RevierteConDireccionCero() public {
        vm.startPrank(owner);
        vm.expectRevert(PagoAtomicoMXNB.DireccionInvalida.selector);
        pago.setTesoreria(address(0));
        vm.expectRevert(PagoAtomicoMXNB.DireccionInvalida.selector);
        pago.setOperador(address(0));
        vm.expectRevert(PagoAtomicoMXNB.DireccionInvalida.selector);
        pago.rescatarTokens(IERC20(address(mxnb)), address(0), 1);
        vm.stopPrank();
    }

    function test_Admin_ComisionNoPuedeSuperarElMaximo() public {
        uint16 maximo = pago.COMISION_MAXIMA_BPS();
        vm.prank(owner);
        vm.expectRevert(PagoAtomicoMXNB.ComisionInvalida.selector);
        pago.setComisionBps(maximo + 1);
    }

    function test_Admin_ReanudarTrasPausa() public {
        vm.startPrank(owner);
        pago.pausar();
        assertTrue(pago.paused());
        pago.reanudar();
        assertFalse(pago.paused());
        vm.stopPrank();
        PagoAtomicoMXNB.Orden memory o = _orden(ORDEN, MONTO);
        _pagar(o, _firmar(operadorPk, o));
    }

    function test_Admin_RenunciaDeshabilitada() public {
        vm.prank(owner);
        vm.expectRevert(PagoAtomicoMXNB.RenunciaDeshabilitada.selector);
        pago.renounceOwnership();
        assertEq(pago.owner(), owner);
    }

    function test_Admin_TransferenciaEnDosPasos() public {
        address nuevoOwner = makeAddr("nuevoOwner");
        vm.prank(owner);
        pago.transferOwnership(nuevoOwner);
        assertEq(pago.owner(), owner);
        assertEq(pago.pendingOwner(), nuevoOwner);

        vm.prank(nuevoOwner);
        pago.acceptOwnership();
        assertEq(pago.owner(), nuevoOwner);
    }

    function test_Admin_RescatarTokens() public {
        vm.prank(comprador);
        mxnb.transfer(address(pago), MONTO); // envío accidental

        address destino = makeAddr("destino");
        vm.expectEmit(true, true, false, true, address(pago));
        emit PagoAtomicoMXNB.TokensRescatados(address(mxnb), destino, MONTO);
        vm.prank(owner);
        pago.rescatarTokens(IERC20(address(mxnb)), destino, MONTO);

        assertEq(mxnb.balanceOf(destino), MONTO);
        assertEq(mxnb.balanceOf(address(pago)), 0);
    }
}
